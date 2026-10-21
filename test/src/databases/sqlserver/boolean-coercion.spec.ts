/*
 * Copyright Contributors to the Malloy project
 * SPDX-License-Identifier: MIT
 */

import {RuntimeList} from '../../runtimes';
import {describeIfDatabaseAvailable} from '../../util';
import '@malloydata/malloy/test/matchers';
import {wrapTestModel} from '@malloydata/malloy/test';

const [describe] = describeIfDatabaseAvailable(['sqlserver']);

// In the boolean_coercion experiment a boolean used as a value is 1, 0 or
// NULL in SQL, which the result reader shows as a boolean, and a boolean
// column read back is a condition again.
describe('SQL Server boolean coercion', () => {
  const runtimes = new RuntimeList(['sqlserver']);
  const runtime = runtimes.runtimeMap.get('sqlserver');
  if (runtime === undefined) {
    throw new Error("Couldn't build runtime");
  }
  const tm = wrapTestModel(
    runtime,
    `##! experimental { sql_functions boolean_coercion }
source: s is sqlserver.sql("SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 2") extend {
  dimension: big is n > 1
  measure: c is count()
}
source: sn is sqlserver.sql("SELECT CAST(NULL AS INT) AS n UNION ALL SELECT 2") extend {
  dimension: big is n > 1
  measure: c is count()
}
source: pk is sqlserver.sql("SELECT 1 AS n UNION ALL SELECT 2") extend {
  dimension: big is n > 1
  primary_key: big
}
source: j is sqlserver.sql("SELECT 1 AS n UNION ALL SELECT 2") extend {
  join_one: pk on pk.n = n
}
`
  );

  afterAll(async () => {
    await runtimes.closeAll();
  });

  test('a boolean result column', async () => {
    await expect(`
      run: s -> { group_by: big; aggregate: c; order_by: big }
    `).toEqualResult(tm, [
      {big: false, c: 1},
      {big: true, c: 2},
    ]);
  });

  test('an unknown condition is NULL', async () => {
    await expect(`
      run: sn -> { group_by: big; aggregate: c; order_by: big }
    `).toEqualResult(tm, [
      {big: null, c: 1},
      {big: true, c: 1},
    ]);
  });

  test('select: * includes the boolean', async () => {
    await expect(`
      run: s -> { select: *; where: n = 1 }
    `).toEqualResult(tm, [{n: 1, big: false}]);
  });

  test('a boolean primary key', async () => {
    await expect(`
      run: j -> { aggregate: keys is pk.count(), total is pk.n.sum() }
    `).toEqualResult(tm, [{keys: 2, total: 3}]);
  });

  test('a boolean column from an earlier stage is a condition again', async () => {
    await expect(`
      run: s -> { group_by: n, big } -> { where: big; select: n }
    `).toEqualResult(tm, [{n: 2}]);
  });

  test('a boolean compared and null-tested', async () => {
    await expect(`
      run: sn -> { aggregate: nulls is c { where: big is null }, trues is c { where: big = true } }
    `).toEqualResult(tm, [{nulls: 1, trues: 1}]);
  });

  test('a condition is still a condition', async () => {
    await expect(`
      run: s -> { where: big; aggregate: c }
    `).toEqualResult(tm, [{c: 2}]);
    await expect(`
      run: s -> { where: not big; aggregate: c }
    `).toEqualResult(tm, [{c: 1}]);
    await expect(`
      run: sn -> { where: not big; aggregate: c }
    `).toEqualResult(tm, [{c: 1}]);
  });
});
