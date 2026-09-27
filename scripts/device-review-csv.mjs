export const MANUAL_REVIEW_COLUMNS = Object.freeze([
  'physical_identity_verified',
  'load_type_verified',
  'route_verified',
  'feedback_policy_verified',
  'review_notes',
]);

export function parseCsvRecords(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      record.push(field);
      if (record.some((value) => value.length > 0)) records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('unterminated quoted CSV field');
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

export function preserveManualReview(columns, currentRows, previousRecords) {
  if (previousRecords.length === 0) return currentRows;
  const previousColumns = previousRecords[0];
  const keyIndex = columns.indexOf('ha_entity_id');
  const previousKeyIndex = previousColumns.indexOf('ha_entity_id');
  if (keyIndex < 0 || previousKeyIndex < 0) throw new Error('device review CSV lacks ha_entity_id column');

  const mappings = MANUAL_REVIEW_COLUMNS
    .map((column) => ({ current: columns.indexOf(column), previous: previousColumns.indexOf(column) }))
    .filter(({ current, previous }) => current >= 0 && previous >= 0);
  const oldByEntity = new Map(previousRecords.slice(1)
    .filter((row) => row[previousKeyIndex])
    .map((row) => [row[previousKeyIndex], row]));

  for (const row of currentRows) {
    const previous = oldByEntity.get(row[keyIndex]);
    if (!previous) continue;
    for (const { current, previous: old } of mappings) {
      if (previous[old] !== undefined && previous[old] !== '') row[current] = previous[old];
    }
  }
  return currentRows;
}
