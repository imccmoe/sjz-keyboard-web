/**
 * 最小 D1 模拟实现，让 tests/ 能在纯 Node 下验证 Pages Functions 逻辑。
 *
 * 策略：先把 bind() 的值按顺序代入 SQL 字面量，再解析得到的纯 SQL。
 * 这样占位符与参数的对齐只发生在 substitution 一处，条件求值不再需要
 * 猜测参数下标，避免了 LIKE ESCAPE、OR 短路、SET/WHERE 混排等场景的错位。
 *
 * 只覆盖本项目用到的语法：? 占位符、单引号字符串、LIKE ... ESCAPE、
 * ON CONFLICT DO UPDATE、COUNT(*) GROUP BY、ORDER BY、LIMIT/OFFSET、db.batch()。
 */

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** 把每个 ? 替换成对应的字面量；占位符顺序就是参数顺序。 */
function substitute(sql, args) {
  let index = 0;
  let inString = false;
  let out = "";
  for (let position = 0; position < sql.length; position += 1) {
    const char = sql[position];
    if (char === "'") {
      out += char;
      if (inString && sql[position + 1] === "'") {
        out += "'";
        position += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (!inString && char === "?") {
      out += sqlLiteral(args[index]);
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

export function countPlaceholders(sql) {
  let inString = false;
  let count = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === "'") {
      if (inString && sql[index + 1] === "'") {
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (!inString && char === "?") count += 1;
  }
  return count;
}

function parseCondition(condition, args) {
  let index = 0;
  const take = () => (index < args.length ? args[index++] : null);
  // 只有 ? 消费参数；条件里的字符串字面量必须原样保留。
  const bound = condition.replace(/'(?:[^']|'')*'|\?/g, (match) => (match === "?" ? sqlLiteral(take()) : match));
  return { bound, consumed: index };
}

function literalValue(token) {
  const trimmed = token.trim();
  if (/^NULL$/i.test(trimmed)) return null;
  const quoted = /^'((?:[^']|'')*)'$/.exec(trimmed);
  if (quoted) return quoted[1].replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function likeToRegExp(pattern) {
  let source = "";
  let escaped = false;
  for (const char of pattern) {
    if (escaped) {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "%") source += "[\\s\\S]*";
    else if (char === "_") source += "[\\s\\S]";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

function compareValues(left, right) {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), "zh-CN");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}:\d{2})?/;

/** 数值列按数值比较，ISO 时间戳按字典序比较，其余按字符串比较。 */
function orderedCompare(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return NaN;
  const leftText = String(left);
  const rightText = String(right);
  if (ISO_DATE.test(leftText) && ISO_DATE.test(rightText)) return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
  const leftNumber = Number(leftText);
  const rightNumber = Number(rightText);
  if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) return leftNumber - rightNumber;
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function compareOp(left, right, operator) {
  if (operator === "=") return left === right || String(left) === String(right);
  if (operator === "<>") return !(left === right || String(left) === String(right));
  const order = orderedCompare(left, right);
  if (Number.isNaN(order)) return false;
  switch (operator) {
    case ">": return order > 0;
    case "<": return order < 0;
    case ">=": return order >= 0;
    case "<=": return order <= 0;
    default: throw new Error(`MockD1 不支持运算符 ${operator}`);
  }
}

/** 条件里的 AND 是外层，OR 只出现在同一组括号内（本项目 SQL 的固定形态）。 */
function matchWhere(row, condition) {
  if (!condition) return true;
  const groups = condition.split(/\s+AND\s+/i).map((part) => part.trim().replace(/^\(|\)$/g, ""));
  return groups.every((group) => group.split(/\s+OR\s+/i).some((part) => matchSingle(row, part.trim())));
}

function matchSingle(row, condition) {
  const binary = /^(\w+)\s*(=|<>|>=|<=|>|<)\s*(.+)$/.exec(condition);
  if (binary) return compareOp(row[binary[1]], literalValue(binary[3]), binary[2]);
  const like = /^(\w+)\s+LIKE\s+(.+?)\s+ESCAPE\s+'\\'$/i.exec(condition);
  if (like) return likeToRegExp(String(literalValue(like[2]))).test(String(row[like[1]] ?? ""));
  throw new Error(`MockD1 无法解析条件：${condition}`);
}

export class MockStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  resolve() {
    return substitute(this.sql, this.params);
  }

  async first(column) {
    const row = this.#select()[0] ?? null;
    if (!row) return null;
    return column ? row[column] : row;
  }

  async all() {
    return { results: this.#select(), success: true };
  }

  async run() {
    return { success: true, meta: { changes: this.#mutate(), duration: 0 } };
  }

  #select() {
    const sql = this.resolve();
    const pattern = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: GROUP BY (\w+))?(?: ORDER BY (.+?))?(?: LIMIT (\d+))?(?: OFFSET (\d+))?$/i;
    const match = pattern.exec(sql);
    if (!match) throw new Error(`MockD1 无法解析：${sql}`);
    const [, projection, table, where, groupBy, orderBy, limit, offset] = match;

    let rows = (this.db.tables[table] || []).filter((row) => matchWhere(row, where));

    if (projection.trim() !== "*") {
      const fields = projection.split(",").map((part) => part.trim());
      const aggregate = fields.find((field) => /COUNT\(|SUM\(/i.test(field));
      if (aggregate) {
        const alias = /\s+AS\s+(\w+)/i.exec(aggregate)?.[1] || "value";
        if (groupBy) {
          // 分组列也可能带别名，例如 feedback_type AS type，必须用别名输出。
          const groupField = fields.find((field) => field !== aggregate) || groupBy;
          const groupAliasMatch = /\s+AS\s+(\w+)/i.exec(groupField);
          const groupAlias = groupAliasMatch ? groupAliasMatch[1] : groupBy;
          const groupColumn = groupAliasMatch ? groupField.slice(0, groupAliasMatch.index).trim() : groupBy;
          const groups = new Map();
          for (const row of rows) {
            const key = row[groupColumn];
            groups.set(key, (groups.get(key) || 0) + 1);
          }
          rows = [...groups.entries()].map(([key, total]) => ({ [groupAlias]: key, [alias]: total }));
        } else {
          rows = [{ [alias]: rows.length }];
        }
      } else {
        rows = rows.map((row) => Object.fromEntries(
          fields.map((field) => {
            const alias = /\s+AS\s+(\w+)/i.exec(field);
            const name = alias ? field.slice(0, alias.index).trim() : field;
            return [alias ? alias[1] : name, row[name]];
          })
        ));
      }
    }

    if (orderBy) {
      const keys = orderBy.split(",").map((part) => {
        const [name, direction] = part.trim().split(/\s+/);
        return { name, desc: /^desc$/i.test(direction || "") };
      });
      rows = [...rows].sort((left, right) => {
        for (const key of keys) {
          const result = compareValues(left[key.name], right[key.name]);
          if (result) return key.desc ? -result : result;
        }
        return 0;
      });
    }

    const start = Number(offset) || 0;
    if (limit) rows = rows.slice(start, start + Number(limit));
    else if (start) rows = rows.slice(start);
    return rows;
  }

  #mutate() {
    const raw = this.sql;
    // INSERT 用显式扫描解析：多行 VALUES 配正则容易触发灾难性回溯。
    if (/^INSERT\s/i.test(raw)) return this.#insert(raw);

    // DELETE FROM table [WHERE ...]
    const remove = /^DELETE FROM (\w+)(?: WHERE (.+))?$/i.exec(raw);
    if (remove) {
      const [, table, wherePart] = remove;
      const whereResolved = substitute(wherePart || "", this.params);
      const list = this.db.tables[table] || (this.db.tables[table] = []);
      const kept = list.filter((row) => !matchWhere(row, whereResolved));
      const changes = list.length - kept.length;
      this.db.tables[table] = kept;
      return changes;
    }

    const update = /^UPDATE (\w+) SET (.+?)(?: WHERE (.+))?$/i.exec(raw);
    if (update) {
      const [, table, setPart, wherePart] = update;
      const setResolved = substitute(setPart, this.params);
      const setArgsUsed = countPlaceholders(setPart);
      const whereResolved = substitute(wherePart || "", this.params.slice(setArgsUsed));
      const assignments = splitTopLevel(setResolved).map((part) => {
        const [column, expression] = part.split("=").map((piece) => piece.trim());
        return { column, expression };
      });
      let changes = 0;
      for (const row of this.db.tables[table] || []) {
        if (!matchWhere(row, whereResolved)) continue;
        for (const assignment of assignments) {
          if (/CURRENT_TIMESTAMP/i.test(assignment.expression)) {
            row[assignment.column] = new Date().toISOString();
          } else if (/^(\w+)\s*\+\s*1$/.test(assignment.expression)) {
            const source = /^(\w+)/.exec(assignment.expression)[1];
            row[assignment.column] = (row[source] || 0) + 1;
          } else if (/^MAX\s*\(\s*(\w+)\s*,\s*(.+?)\s*\)$/i.test(assignment.expression)) {
            // MAX(value, N) 或 MAX(value, 9 + 1)：D1 里的「至少推进到 N」
            const [, source, expression] = /^MAX\s*\(\s*(\w+)\s*,\s*(.+?)\s*\)$/i.exec(assignment.expression);
            const addition = /^(\d+)\s*\+\s*(\d+)$/.exec(expression);
            const floorValue = addition
              ? Number(addition[1]) + Number(addition[2])
              : Number(expression) || 0;
            row[assignment.column] = Math.max(Number(row[source]) || 0, floorValue);
          } else {
            row[assignment.column] = literalValue(assignment.expression);
          }
        }
        changes += 1;
      }
      return changes;
    }

    throw new Error(`MockD1 无法解析：${raw}`);
  }

  /**
   * 解析 INSERT [OR REPLACE|IGNORE] INTO table (cols) VALUES (..), (..) [ON CONFLICT ..]。
   * 用扫描而不是正则，避免多行 VALUES 上的回溯问题。
   */
  #insert(raw) {
    const match = /^INSERT(?:\s+OR\s+(REPLACE|IGNORE))?\s+INTO\s+(\w+)\s*/i.exec(raw);
    if (!match) throw new Error(`MockD1 无法解析 INSERT：${raw.slice(0, 80)}`);
    const mode = (match[1] || "").toUpperCase();
    const table = match[2];
    let cursorIndex = match[0].length;

    const columnsBlock = readParenthesized(raw, cursorIndex);
    if (!columnsBlock) throw new Error("MockD1：INSERT 缺少列清单");
    const columns = columnsBlock.content.split(",").map((part) => part.trim());
    cursorIndex = columnsBlock.end;

    const valuesKeyword = /^\s*VALUES\s*/i.exec(raw.slice(cursorIndex));
    if (!valuesKeyword) throw new Error("MockD1：INSERT 缺少 VALUES");
    cursorIndex += valuesKeyword[0].length;

    // 连续读取 (...), (...), ... 直到出现非逗号分隔的内容。
    const rowTexts = [];
    while (cursorIndex < raw.length) {
      const block = readParenthesized(raw, cursorIndex);
      if (!block) break;
      rowTexts.push(block.content);
      cursorIndex = block.end;
      const separator = /^\s*,\s*/.exec(raw.slice(cursorIndex));
      if (!separator) break;
      cursorIndex += separator[0].length;
    }
    if (!rowTexts.length) throw new Error("MockD1：INSERT 没有可解析的行");

    const tail = raw.slice(cursorIndex);
    // 支持：ON CONFLICT(cols) DO NOTHING / DO UPDATE SET <任意赋值列表>
    const conflictMatch = /^\s*ON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+(NOTHING|UPDATE\s+SET\s+([\s\S]+))$/i.exec(tail.trim());
    const conflict = conflictMatch
      ? [
        conflictMatch[0],
        conflictMatch[1],
        conflictMatch[2].toUpperCase() === "NOTHING" ? "DO NOTHING" : conflictMatch[3]
      ]
      : null;

    // 占位符在整条 VALUES 中按顺序排列，所以需要一个跨 token 的游标。
    let cursor = 0;
    const parsed = rowTexts.map((rowText) => {
      const row = {};
      splitTopLevel(rowText).forEach((token, index) => {
        const needed = countPlaceholders(token);
        row[columns[index]] = literalValue(substitute(token, this.params.slice(cursor, cursor + needed)));
        cursor += needed;
      });
      return row;
    });

    const list = this.db.tables[table] || (this.db.tables[table] = []);
    if (conflict && parsed.length) {
      const keys = conflict[1].split(",").map((part) => part.trim());
      const existing = list.find((item) => keys.every((key) => item[key] === parsed[0][key]));
      if (existing) {
        // DO NOTHING：什么都不做
        if (/^DO\s+NOTHING/i.test(conflict[2])) return 0;
        // DO UPDATE SET a = excluded.a, b = ... ：把新值覆盖到已有行上
        for (const assignment of splitTopLevel(conflict[2])) {
          const [column, expression] = assignment.split("=").map((piece) => piece.trim());
          const excluded = /^excluded\.(\w+)$/i.exec(expression);
          if (excluded) {
            existing[column] = parsed[0][excluded[1]];
          } else if (expression.toUpperCase() === "CURRENT_TIMESTAMP") {
            existing[column] = new Date().toISOString();
          } else {
            const literal = literalValue(expression);
            existing[column] = literal === null ? expression : literal;
          }
        }
        return 1;
      }
    }
    if (conflict && !parsed.length) return 0;

    const primary = this.db.primaryKeys?.[table];
    let changes = 0;
    for (const entry of parsed) {
      if (mode === "REPLACE" && primary) {
        const index = list.findIndex((item) => item[primary] === entry[primary]);
        if (index >= 0) {
          list[index] = entry;
          changes += 1;
          continue;
        }
      }
      if (mode === "IGNORE" && primary && list.some((item) => item[primary] === entry[primary])) {
        continue;
      }
      list.push(entry);
      changes += 1;
    }
    return changes;
  }
}

/** 从 offset 处读取一个平衡括号块，返回内部文本与结束位置。 */
function readParenthesized(text, offset) {
  let index = offset;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (text[index] !== "(") return null;
  let depth = 0;
  let inString = false;
  const start = index + 1;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") {
      if (inString && text[index + 1] === "'") {
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return { content: text.slice(start, index), end: index + 1 };
    }
  }
  return null;
}

/** 按顶层分隔符拆分，跳过引号内的内容以及括号内的同名分隔符。 */
function splitTopLevelWith(value, separator) {
  const parts = [];
  let current = "";
  let inString = false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'") {
      current += char;
      if (inString && value[index + 1] === "'") {
        current += "'";
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      else if (depth === 0 && value.startsWith(separator, index)) {
        parts.push(current);
        current = "";
        index += separator.length - 1;
        continue;
      }
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** 按顶层逗号拆分。 */
function splitTopLevel(value) {
  return splitTopLevelWith(value, ",");
}

export class MockD1 {
  constructor(seed = {}, { primaryKeys = {} } = {}) {
    this.tables = {};
    this.primaryKeys = primaryKeys;
    for (const [table, rows] of Object.entries(seed)) this.tables[table] = rows.map((row) => ({ ...row }));
  }

  prepare(sql) {
    return new MockStatement(this, sql);
  }

  /** 与真实 D1 一致：batch() 返回一个可 await 的结果数组。 */
  batch(statements) {
    return (async () => {
      const results = [];
      for (const statement of statements) {
        const head = statement.sql.trim().toUpperCase();
        results.push(head.startsWith("SELECT") || head.startsWith("WITH")
          ? await statement.all()
          : await statement.run());
      }
      return results;
    })();
  }
}

export function schemeRow(overrides = {}) {
  return {
    id: "hub_test", game: "delta", mode: "operations", weapon_name: "测试步枪",
    object_name: "M4A1", weapon_type: "步枪", ammo: "", map: "", image: "",
    value_score: 100, price: 1000, usage_count: 5, like_count: 1, author_id: null,
    author_name: "测试作者", gun_code: "M4A1-烽火地带-TEST-CODE", adapter_config: "",
    sensitivity_note: "", status: "active", source: "orzice-authorized", source_id: "1",
    extra_json: JSON.stringify({ params: { control: 60, stability: 40 }, feedback: { good: 1 } }),
    created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}
