export type PageDetailsRow = { name: string; bio: string };

export function parsePageDetailsCsv(text: string): PageDetailsRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell.trim()); cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[index + 1] === "\n") index++;
      row.push(cell.trim());
      if (row.some((value) => value.length)) rows.push(row);
      row = []; cell = "";
    } else cell += character;
  }
  if (quoted) throw new Error("The names and bios CSV contains an unfinished quoted field.");
  row.push(cell.trim());
  if (row.some((value) => value.length)) rows.push(row);
  if (!rows.length) throw new Error("Choose a names and bios CSV file.");
  const headers = rows[0].map((value) => value.toLowerCase());
  const nameIndex = headers.findIndex((value) => ["name", "page name"].includes(value));
  const bioIndex = headers.findIndex((value) => ["bio", "about"].includes(value));
  if (nameIndex < 0 || bioIndex < 0) throw new Error("The CSV needs a header row with name,bio columns.");
  return rows.slice(1).map((values) => ({ name: values[nameIndex] ?? "", bio: values[bioIndex] ?? "" }));
}
