// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

var assert = require('assert');
var RouterCache = require('../router_cache');

describe('Router Cache', function() {
  var cache = null;
  var maxAge = 20; // 5ms
  var tenantId = 'some-tenant';
  var targetName = 'some-peer';

  beforeEach(function() {
    cache = new RouterCache({ maxAge: maxAge });
  });

  it('can be initialized without options', function() {
    new RouterCache();
  });

  it('#get will return serverUrl if called before maxAge expires', function(done) {
    cache.set(tenantId, targetName, 'http://localhost:3000');
    assert.equal(cache.get(tenantId, targetName), 'http://localhost:3000');
    setTimeout(function() {
      assert.equal(cache.get(tenantId, targetName), 'http://localhost:3000');
      done();
    }, maxAge/2);
  });


  it('#get will return undefined after maxAge expires', function(done) {
    cache.set(tenantId, targetName, 'http://localhost:3000');
    assert.equal(cache.get(tenantId, targetName), 'http://localhost:3000');
    setTimeout(function() {
      assert.equal(cache.get(tenantId, targetName), undefined);
      done();
    }, maxAge + 1);
  });

  it('#get will return serverUrl if cache was updated before maxAge expires', function(done) {
    cache.set(tenantId, targetName, 'http://localhost:3000');
    assert.equal(cache.get(tenantId, targetName), 'http://localhost:3000');
    setTimeout(function() {
      cache.set(tenantId, targetName, 'http://localhost:4444');

      setTimeout(function() {
        assert.equal(cache.get(tenantId, targetName), 'http://localhost:4444');
        done();
      }, maxAge / 2 );
    }, maxAge / 2 );
  });

  it('#keys will return all keys for a given tenant', function() {
    cache.set('tenant-1', 'target-1', 'http://localhost:3000');
    cache.set('tenant-1', 'target-2', 'http://localhost:3000');
    cache.set('tenant-2', 'target-1', 'http://localhost:3000');
    assert.equal(cache.keys('tenant-1').length, 2);
    assert.equal(cache.keys('tenant-2').length, 1);
    assert.equal(cache.keys('tenant-2')[0].tenantId, 'tenant-2');
    assert.equal(cache.keys('tenant-2')[0].targetName, 'target-1');
  });

  it('#keys will return all keys for a given tenant with slashes in tenant', function() {
    cache.set('tenant/1', 'target/1', 'http://localhost:3000');
    cache.set('tenant/1', 'target/2', 'http://localhost:3000');
    cache.set('tenant/2', 'target/1', 'http://localhost:3000');
    assert.equal(cache.keys('tenant/1').length, 2);
    assert.equal(cache.keys('tenant/2').length, 1);
    assert.equal(cache.keys('tenant/2')[0].tenantId, 'tenant/2');
    assert.equal(cache.keys('tenant/2')[0].targetName, 'target/1');
  });

  it('#keys will return all keys when no tenant is given', function() {
    cache.set('tenant-1', 'target-1', 'http://localhost:3000');
    cache.set('tenant-1', 'target-2', 'http://localhost:3000');
    cache.set('tenant-2', 'target-1', 'http://localhost:3000');
    assert.equal(cache.keys().length, 3);
  });

  it('#reset will clear cache', function() {
    cache.set('tenant-1', 'target-1', 'http://localhost:3000');
    cache.set('tenant-1', 'target-2', 'http://localhost:3000');
    cache.set('tenant-2', 'target-1', 'http://localhost:3000');
    assert.equal(cache.keys().length, 3);
    cache.reset();
    assert.equal(cache.keys().length, 0);
    assert.equal(cache.get('tenant-1', 'target-1'), undefined);
  })

});
