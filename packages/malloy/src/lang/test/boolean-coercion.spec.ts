/*
 * Copyright Contributors to the Malloy project
 * SPDX-License-Identifier: MIT
 */

import './parse-expects';
import {TestTranslator} from './test-translator';
import {QueryModel} from '../../model';

// In the boolean_coercion experiment, a boolean on a dialect with
// booleanType 'none' is still a condition, and the compiler turns it into
// a value (1, 0, or NULL) wherever SQL wants a value, and a value back into
// a condition wherever SQL wants a condition. Nothing is refused.
const prefix = `##! experimental { dialect.sqlserver parameters sql_functions boolean_coercion }
source: m is _mssql_.table('aTable') extend {
  dimension: big is ai > 5
  dimension: sb is sql_boolean("""ai > 7""")
  measure: n is count()
  measure: anyn is n > 1
  join_one: o is _mssql_.table('aTable') extend { dimension: big is ai > 5 } on o.ai = ai
}
source: pk is _mssql_.table('aTable') extend {
  dimension: big is ai > 5
  primary_key: big
}
source: pkj is _mssql_.table('aTable') extend {
  dimension: big is ai > 5
  join_one: pk on pk.ai = ai
}
source: pm(p::boolean is true) is _mssql_.table('aTable') extend {
  dimension: pv is p
  measure: n is count()
}
`;

function sqlOf(query: string): string {
  const tt = new TestTranslator(prefix + query);
  expect(tt).toTranslate();
  const modelDef = tt.translate().modelDef!;
  const ql = modelDef.queryList;
  const compiled = new QueryModel(modelDef).compileQuery(ql[ql.length - 1]);
  return compiled.sql.replace(/\s+/g, ' ');
}

const bigCond = '(base."ai">5)';
// At the root of a field's expression the comparison is not wrapped
const bigValue =
  'CASE WHEN base."ai">5 THEN 1 WHEN NOT (base."ai">5) THEN 0 END';
// Through a reference to the field, it is
const bigRef = `(${bigValue})`;
const trueValue = 'CASE WHEN (1=1) THEN 1 WHEN NOT ((1=1)) THEN 0 END';

describe('boolean coercion on a dialect without boolean values', () => {
  describe('a condition where a value is wanted becomes 1, 0 or NULL', () => {
    test('as a result column', () => {
      expect(sqlOf('run: m -> { group_by: big }')).toContain(
        `${bigValue} as "big"`
      );
    });
    test('as a selected column', () => {
      expect(sqlOf('run: m -> { select: big }')).toContain(
        `${bigValue} as "big"`
      );
    });
    test('in select: *, with no warning', () => {
      expect(sqlOf('run: m -> { select: * }')).toContain(
        `${bigValue} as "big"`
      );
    });
    test('a literal', () => {
      expect(sqlOf('run: m -> { group_by: t is true }')).toContain(
        `${trueValue} as "t"`
      );
    });
    test('a boolean function', () => {
      const sql = sqlOf("run: m -> { group_by: s is starts_with(astr, 'a') }");
      expect(sql).toMatch(
        /CASE WHEN LEFT\(.*\) = N'a' THEN 1 WHEN NOT \(LEFT\(.*\) = N'a'\) THEN 0 END as "s"/
      );
    });
    test('a sql_boolean', () => {
      expect(sqlOf('run: m -> { group_by: sb }')).toContain(
        'CASE WHEN ai > 7 THEN 1 WHEN NOT (ai > 7) THEN 0 END as "sb"'
      );
    });
    test('a boolean parameter', () => {
      expect(sqlOf('run: pm -> { group_by: pv }')).toContain(
        `${trueValue} as "pv"`
      );
    });
    test('compared', () => {
      expect(sqlOf('run: m -> { where: big = true; aggregate: n }')).toContain(
        `WHERE ${bigRef}=${trueValue}`
      );
    });
    test('null tested', () => {
      expect(sqlOf('run: m -> { where: big is null; aggregate: n }')).toContain(
        `WHERE ${bigRef} IS NULL`
      );
    });
    test('as a function argument', () => {
      expect(sqlOf('run: m -> { group_by: s is concat(big) }')).toContain(
        `CONCAT(${bigRef})`
      );
    });
    test('as a pick result', () => {
      expect(
        sqlOf('run: m -> { group_by: x is pick big when ai > 1 else false }')
      ).toContain(
        `CASE WHEN (base."ai">1) THEN ${bigRef} ELSE CASE WHEN (1=0) THEN 1 WHEN NOT ((1=0)) THEN 0 END END as "x"`
      );
    });
    test('cast', () => {
      expect(sqlOf('run: m -> { group_by: x is big::number }')).toContain(
        `CAST(${bigRef} AS`
      );
    });
    test('in a window function', () => {
      expect(
        sqlOf('run: m -> { group_by: big; calculate: x is lag(big) }')
      ).toContain(`LAG(${bigRef})`);
    });
    test('as a primary key, hashed and counted', () => {
      expect(sqlOf('run: pkj -> { aggregate: x is pk.count() }')).toContain(
        'COUNT(DISTINCT (CASE WHEN pk_0."ai">5 THEN 1 WHEN NOT (pk_0."ai">5) THEN 0 END))'
      );
      expect(sqlOf('run: pkj -> { aggregate: x is pk.ai.sum() }')).toContain(
        'HASHBYTES(\'MD5\', CAST((CASE WHEN pk_0."ai">5 THEN 1 WHEN NOT (pk_0."ai">5) THEN 0 END) AS NVARCHAR(MAX)))'
      );
    });
  });

  describe('a value where a condition is wanted is tested against 1', () => {
    test('an ungrouped boolean measure in having:', () => {
      expect(
        sqlOf('run: m -> { group_by: ai; aggregate: n; having: all(anyn) }')
      ).toContain(
        'HAVING (MAX((CASE WHEN (COUNT(1))>1 THEN 1 WHEN NOT ((COUNT(1))>1) THEN 0 END)) OVER () = 1)'
      );
    });
    test('a boolean column from an earlier stage', () => {
      expect(
        sqlOf('run: m -> { group_by: ai, big } -> { where: big; select: ai }')
      ).toContain('WHERE (base."big" = 1)');
    });
    test('?? of booleans', () => {
      expect(
        sqlOf('run: m -> { where: big ?? false; aggregate: n }')
      ).toContain(
        `WHERE (COALESCE(${bigRef},CASE WHEN (1=0) THEN 1 WHEN NOT ((1=0)) THEN 0 END) = 1)`
      );
    });
  });

  describe('a condition where a condition is wanted is unchanged', () => {
    test('where:', () => {
      const sql = sqlOf('run: m -> { where: big; aggregate: n }');
      expect(sql).toContain(`WHERE ${bigCond}`);
      expect(sql).not.toContain('CASE');
    });
    test('having:', () => {
      const sql = sqlOf('run: m -> { aggregate: n; having: anyn }');
      expect(sql).toContain('HAVING ((COUNT(1))>1)');
      expect(sql).not.toContain('CASE');
    });
    test('a join on:', () => {
      const sql = sqlOf(
        'source: j is m extend { join_one: q is m on q.ai = ai and big }\nrun: j -> { aggregate: x is q.n }'
      );
      expect(sql).toContain('ON (q_0."ai"=base."ai") and (base."ai">5)');
      expect(sql).not.toContain('CASE WHEN (base."ai">5) THEN 1');
    });
    test('a source where:', () => {
      const sql = sqlOf(
        'source: s2 is m extend { where: big }\nrun: s2 -> { aggregate: n }'
      );
      expect(sql).toContain(`WHERE ${bigCond}`);
      expect(sql).not.toContain('CASE');
    });
    test('a filtered aggregate', () => {
      const sql = sqlOf('run: m -> { aggregate: x is n { where: big } }');
      expect(sql).toContain(`COUNT(CASE WHEN ${bigCond} THEN 1 END)`);
    });
    test('pick … when', () => {
      const sql = sqlOf(
        "run: m -> { group_by: x is pick 'yes' when big else 'no' }"
      );
      expect(sql).toContain(`CASE WHEN ${bigCond} THEN N'yes' ELSE N'no' END`);
    });
    test('not, and, or', () => {
      const sql = sqlOf(
        'run: m -> { where: not big and (big or ai = 1); aggregate: n }'
      );
      expect(sql).toContain(
        `WHERE (CASE WHEN ${bigCond} THEN 1 ELSE 0 END = 0) and ((${bigCond} or (base."ai"=1)))`
      );
    });
    test('a boolean function as a filter', () => {
      const sql = sqlOf(
        "run: m -> { where: starts_with(astr, 'a'); aggregate: n }"
      );
      expect(sql).toMatch(/WHERE LEFT\(/);
      expect(sql).not.toContain('CASE');
    });
    test('a boolean parameter as a filter', () => {
      const sql = sqlOf('run: pm -> { where: pv; aggregate: n }');
      expect(sql).toContain('WHERE ((1=1))');
    });
  });

  test('without the experiment a boolean value is still refused', () => {
    const tt = new TestTranslator(
      `##! experimental.dialect.sqlserver
source: m is _mssql_.table('aTable') extend { dimension: big is ai > 5 }
run: m -> { group_by: big }`
    );
    const problems = tt.translate().problems ?? [];
    expect(problems.map(p => p.code)).toContain('boolean-value-unsupported');
  });
});
