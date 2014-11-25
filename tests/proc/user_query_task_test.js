/**
 * @license
 * Copyright 2014 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
goog.setTestOnly();
goog.require('goog.Promise');
goog.require('goog.testing.AsyncTestCase');
goog.require('goog.testing.jsunit');
goog.require('goog.userAgent.product');
goog.require('hr.db');
goog.require('lf.Exception');
goog.require('lf.Global');
goog.require('lf.TransactionType');
goog.require('lf.bind');
goog.require('lf.cache.Journal');
goog.require('lf.proc.UserQueryTask');
goog.require('lf.query');
goog.require('lf.service');
goog.require('lf.testing.hrSchemaSampleData');


/** @type {!goog.testing.AsyncTestCase} */
var asyncTestCase = goog.testing.AsyncTestCase.createAndInstall(
    'UserQueryTaskTest');


/** @type {!lf.Database} */
var db;


/** @type {!lf.BackStore} */
var backStore;


/** @type {!lf.cache.Cache} */
var cache;


/** @type {!Array.<!lf.Row>} */
var rows;


/** @type {!hr.db.schema.Job} */
var j;


/** @const {number} */
var ROW_COUNT = 5;


function setUp() {
  asyncTestCase.waitForAsync('setUp');
  hr.db.getInstance(undefined, true).then(function(database) {
    db = database;
    backStore = lf.Global.get().getService(lf.service.BACK_STORE);
    cache = lf.Global.get().getService(lf.service.CACHE);
    j = db.getSchema().getJob();
  }).then(function() {
    asyncTestCase.continueTesting();
  }, fail);
}


function tearDown() {
  asyncTestCase.waitForAsync('tearDown');
  db.delete().from(j).exec().then(function() {
    asyncTestCase.continueTesting();
  });
}


/**
 * Creates a physical plan that inserts ROW_COUNT rows into the Album table.
 * @return {!lf.query.InsertContext}
 */
function getSampleQuery() {
  rows = [];
  for (var i = 0; i < ROW_COUNT; ++i) {
    var job = lf.testing.hrSchemaSampleData.generateSampleJobData(db);
    job.setId('jobId' + i.toString());
    rows.push(job);
  }
  return /** @type {!lf.query.InsertBuilder} */ (
      db.insert().into(j).values(rows)).query;
}


/**
 * Tests that an INSERT query does indeed add a new record in the database,
 * and update the cache.
 */
function testSinglePlan_Insert() {
  asyncTestCase.waitForAsync('testSinglePlan_Insert');
  assertEquals(0, cache.getCount());

  var queryTask = new lf.proc.UserQueryTask(
      lf.Global.get(), [getSampleQuery()]);
  queryTask.exec().then(function() {
    return selectAll();
  }).then(function(results) {
    assertEquals(ROW_COUNT, results.length);
    assertEquals(ROW_COUNT, cache.getCount());
    for (var i = 0; i < ROW_COUNT; ++i) {
      assertEquals(rows[i].id(), results[i].id());
      assertObjectEquals(rows[i].payload(), results[i].payload());
    }
    asyncTestCase.continueTesting();
  }, fail);
}


/**
 * Tests that an UPDATE query does change the record in the database and cache.
 */
function testSinglePlan_Update() {
  asyncTestCase.waitForAsync('testSinglePlan_Update');
  assertEquals(0, cache.getCount());

  var newTitle = 'Quantum Physicist';
  var queryTask = new lf.proc.UserQueryTask(
      lf.Global.get(), [getSampleQuery()]);
  queryTask.exec().then(function() {
    assertEquals(ROW_COUNT, cache.getCount());
    var query = /** @type {!lf.query.UpdateBuilder} */ (
        db.update(j).set(j.title, newTitle)).query;
    var updateQueryTask = new lf.proc.UserQueryTask(
        lf.Global.get(), [query]);
    return updateQueryTask.exec();
  }).then(function() {
    return selectAll();
  }).then(function(results) {
    assertEquals(ROW_COUNT, results.length);
    assertEquals(ROW_COUNT, cache.getCount());
    for (var i = 0; i < ROW_COUNT; ++i) {
      assertEquals(newTitle, results[i].payload()[j.title.getName()]);
      var id = rows[i].id();
      assertEquals(newTitle, cache.get([id])[0].payload()[j.title.getName()]);
    }
    asyncTestCase.continueTesting();
  });
}


/**
 * Tests that an DELETE query does delete the record in the database and cache.
 */
function testSinglePlan_Delete() {
  asyncTestCase.waitForAsync('testSinglePlan_Delete');
  assertEquals(0, cache.getCount());

  var queryTask = new lf.proc.UserQueryTask(
      lf.Global.get(), [getSampleQuery()]);
  queryTask.exec().then(function() {
    assertEquals(ROW_COUNT, cache.getCount());
    var query = /** @type {!lf.query.DeleteBuilder} */ (
        db.delete().from(j)).query;
    var deleteQueryTask = new lf.proc.UserQueryTask(
        lf.Global.get(), [query]);
    return deleteQueryTask.exec();
  }).then(function() {
    return selectAll();
  }).then(function(results) {
    assertEquals(0, results.length);
    assertEquals(0, cache.getCount());
    asyncTestCase.continueTesting();
  });
}


/**
 * Tests that a UserQueryTask that includes multiple queries updates both
 * database and cache.
 */
function testMultiPlan() {
  asyncTestCase.waitForAsync('testMultiPlan');
  assertEquals(0, cache.getCount());

  rows = [];
  for (var i = 0; i < ROW_COUNT; ++i) {
    var job = lf.testing.hrSchemaSampleData.generateSampleJobData(db);
    job.setId('jobId' + i.toString());
    rows.push(job);
  }

  var newTitle = 'Quantum Physicist';
  var deletedId = 'jobId2';

  var insertQuery = /** @type {!lf.query.InsertBuilder} */ (
      db.insert().into(j).values(rows)).getQuery();
  var updateQuery = /** @type {!lf.query.UpdateBuilder} */ (
      db.update(j).set(j.title, newTitle)).getQuery();
  var removeQuery = /** @type {!lf.query.DeleteBuilder} */ (
      db.delete().from(j).where(j.id.eq(deletedId))).getQuery();

  var queryTask = new lf.proc.UserQueryTask(
      lf.Global.get(), [insertQuery, updateQuery, removeQuery]);

  queryTask.exec().then(function() {
    assertEquals(ROW_COUNT - 1, cache.getCount());

    return selectAll();
  }).then(function(results) {
    assertEquals(ROW_COUNT - 1, results.length);
    for (var i = 0; i < results.length; ++i) {
      assertEquals(newTitle, results[i].payload()[j.title.getName()]);
      assertFalse(results[i].payload()[j.id.getName()] == deletedId);
    }
    asyncTestCase.continueTesting();
  });
}


/**
 * Testing that when a UserQueryTask fails to execute a rejected promise is
 * returned and that indices, cache and backstore are in the state prior to the
 * task have been started.
 */
function testMultiPlan_Rollback() {
  asyncTestCase.waitForAsync('testRollback');
  assertEquals(0, cache.getCount());

  var job = lf.testing.hrSchemaSampleData.generateSampleJobData(db);
  // Creating two queries to be executed within the same transaction. The second
  // query will fail because of a primary key constraint violation. Expecting
  // the entire transaction to be rolled back as if it never happened.
  var insertQuery = /** @type {!lf.query.InsertBuilder} */ (
      db.insert().into(j).values([job])).getQuery();
  var insertAgainQuery = /** @type {!lf.query.InsertBuilder} */ (
      db.insert().into(j).values([job])).getQuery();

  var queryTask = new lf.proc.UserQueryTask(
      lf.Global.get(), [insertQuery, insertAgainQuery]);
  queryTask.exec().then(
      fail,
      function(e) {
        assertEquals(lf.Exception.Type.CONSTRAINT, e.name);
        assertEquals(0, cache.getCount());
        selectAll().then(
            function(results) {
              assertEquals(0, results.length);
              asyncTestCase.continueTesting();
            });
      });
}


/**
 * Tests that when a parametrized query finishes execution, observers are
 * notified.
 */
function testSinglePlan_ParametrizedQuery() {
  // TODO: Array.observe currently exists only in Chrome. Polyfiling mechanism
  // not ready yet, see b/18331726. Remove this once fixed.
  if (!goog.userAgent.product.CHROME) {
    return;
  }

  asyncTestCase.waitForAsync('testSinglePlan_ParametrizedQuery');

  var selectQueryBuilder = /** @type {!lf.query.SelectBuilder} */ (
      db.select().from(j).where(j.id.between(lf.bind(0), lf.bind(1))));

  var observerCallback = function(changes) {
    // Expecting one "change" record for each of rows with IDs jobId2, jobId3,
    // jobId4.
    assertEquals(3, changes.length);
    changes.forEach(function(change) {
      assertEquals(1, change['addedCount']);
    });

    lf.query.unobserve(selectQueryBuilder, observerCallback);
    asyncTestCase.continueTesting();
  };

  var insertQueryTask = new lf.proc.UserQueryTask(
      lf.Global.get(), [getSampleQuery()]);

  insertQueryTask.exec().then(function() {
    // Start observing.
    lf.query.observe(selectQueryBuilder, observerCallback);

    // Bind parameters to some values.
    selectQueryBuilder.bind(['jobId2', 'jobId4']);

    var selectQueryTask = new lf.proc.UserQueryTask(
        lf.Global.get(), [selectQueryBuilder.getQuery()]);
    return selectQueryTask.exec();
  }, fail);
}


/**
 * Selects all entries from the database (skips the cache).
 * @return {!IThenable}
 */
function selectAll() {
  var tx = backStore.createTx(
      lf.TransactionType.READ_ONLY,
      new lf.cache.Journal([j]));
  return tx.getTable(j).get([]);
}
