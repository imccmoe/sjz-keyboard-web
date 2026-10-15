// 测试用 SQL 文本工具：按顶层分号切分语句，正确处理 '...' 与 '' 转义。

export function splitStatements(sql) {
  const statements = [];
  let current = "";
  let inString = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === "'") {
      current += char;
      if (inString && sql[index + 1] === "'") {
        current += "'";
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (!inString && char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements
    .map((statement) => statement.replace(/^(--[^\n]*\n)+/, "").trim())
    .filter(Boolean);
}
