// One-time (or re-runnable) importer for the master customer CSV.
//
// Usage:
//   node src/db/import-csv.js /path/to/انوار_الجنتين_قاعدة_العملاء_MASTER_v2.csv
//
// Behavior:
//   * Never deletes existing rows.
//   * Upserts by phone_e164 (ON CONFLICT ... DO UPDATE) so re-running
//     with an updated CSV refreshes classification fields without
//     creating duplicate customers.
//   * Rows with no usable phone number are still imported (so the
//     master record count matches the CSV) but phone_e164 is left
//     NULL and they will simply never be selected into any campaign.
//
// Phone normalization mirrors what we found the CSV already does in
// "الرقم بعد التنظيف", but we re-derive it defensively here rather
// than trusting the column blindly, in case a future CSV export
// changes format.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const pool = require('./pool');

function normalizePhone(rawCleaned, rawOriginal) {
  // Prefer the pre-cleaned column; fall back to the original if empty.
  let x = (rawCleaned || rawOriginal || '').trim();
  if (!x) return null;

  // Handle "+967777797700 ::: +967777797700" style duplicated values
  // seen in the source data -- take the first token.
  x = x.split(':::')[0].trim();

  // Strip everything except digits and a leading +
  x = x.replace(/[^0-9+]/g, '');
  if (x.startsWith('+')) x = x.slice(1);

  // Yemeni mobile: 77/78/70/71/73 + 7 digits (9 digits total after prefix)
  if (/^7[0137]\d{7}$/.test(x)) return '+967' + x;
  if (/^07[0137]\d{7}$/.test(x)) return '+967' + x.slice(1);
  if (/^9677[0137]\d{7}$/.test(x)) return '+' + x;

  // Anything else (foreign numbers, landlines, junk): keep normalized
  // with a leading + if it looks like a real international number,
  // otherwise null it out -- we do NOT want to guess.
  if (/^\d{7,15}$/.test(x)) return '+' + x;
  return null;
}

function isValidYemeniE164(phoneE164) {
  return !!phoneE164 && /^\+9677[0137]\d{7}$/.test(phoneE164);
}

function toBool(v) {
  if (!v) return false;
  const s = String(v).trim();
  return /^(نعم|true|1)$/i.test(s);
}

async function importCsv(filePath) {
  const absPath = path.resolve(filePath);
  console.log('[import-csv] reading', absPath);

  const content = fs.readFileSync(absPath); // Buffer -- csv-parse handles BOM via bom:true
  const records = [];

  const parser = parse(content, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  for await (const row of parser) {
    records.push(row);
  }

  console.log(`[import-csv] parsed ${records.length} rows, importing...`);

  const client = await pool.connect();
  let inserted = 0;
  let updated = 0;
  let skippedNoPhone = 0;

  try {
    await client.query('BEGIN');

    for (const row of records) {
      const name = row['الاسم'] || null;
      const company = row['الجهة/الشركة'] || null;
      const phoneRaw = row['الرقم الأصلي'] || null;
      const phoneCleanedCol = row['الرقم بعد التنظيف'] || null;
      const country = row['الدولة'] || null;
      const status = row['الحالة'] || null;
      const businessCategory = row['الفئات_المصنفة'] || row['الفئات_المهنية'] || null;
      const detectedLocations = row['المواقع_المصنفة'] || row['المواقع_المكتشفة'] || null;
      const targetGroup = row['مجموعة_الاستهداف_المحدثة'] || row['مجموعة_الاستهداف'] || null;
      const isTrader = toBool(row['تاجر_وفق_القواعد_المحدث'] || row['تاجر_وفق_قواعدك']);
      const classificationGrade = row['درجة_التصنيف'] || null;
      const isDuplicatePhone = toBool(row['مكرر_رقم']);

      const phoneE164 = normalizePhone(phoneCleanedCol, phoneRaw);
      const isValidYemeni = phoneE164
        ? isValidYemeniE164(phoneE164)
        : false;

      if (!phoneE164) skippedNoPhone++;

      const result = await client.query(
        `INSERT INTO customers (
           name, company, phone_raw, phone_e164, country, status,
           business_category, detected_locations, target_group,
           is_trader, classification_grade, is_duplicate_phone,
           is_valid_yemeni_number
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (phone_e164) WHERE phone_e164 IS NOT NULL AND phone_e164 <> ''
         DO UPDATE SET
           name = EXCLUDED.name,
           company = EXCLUDED.company,
           status = EXCLUDED.status,
           business_category = EXCLUDED.business_category,
           detected_locations = EXCLUDED.detected_locations,
           target_group = EXCLUDED.target_group,
           is_trader = EXCLUDED.is_trader,
           classification_grade = EXCLUDED.classification_grade,
           is_duplicate_phone = EXCLUDED.is_duplicate_phone,
           is_valid_yemeni_number = EXCLUDED.is_valid_yemeni_number,
           updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [
          name, company, phoneRaw, phoneE164, country, status,
          businessCategory, detectedLocations, targetGroup,
          isTrader, classificationGrade, isDuplicatePhone,
          isValidYemeni,
        ]
      );

      if (phoneE164) {
        if (result.rows[0].inserted) inserted++;
        else updated++;
      } else {
        // No phone_e164 -> the partial unique index doesn't apply,
        // so every such row is a fresh insert. That's fine: these
        // customers can never be targeted by a campaign anyway.
        inserted++;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log('[import-csv] done.');
  console.log(`  inserted: ${inserted}`);
  console.log(`  updated (existing phone matched): ${updated}`);
  console.log(`  rows with no usable phone number: ${skippedNoPhone}`);

  await pool.end();
}

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node src/db/import-csv.js /path/to/customers.csv');
  process.exit(1);
}

importCsv(filePath).catch((err) => {
  console.error('[import-csv] FAILED:', err);
  process.exit(1);
});
