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
var RouterClient = require('../clients/router_client');
var MockEtcd = require('./mocks/mock_etcd');

describe('Router client', function() {
  var client = null;
  var tenantId = 'example-tenant';

  beforeEach(function() {
    client = new RouterClient({ client: new MockEtcd });  
    var keyValuePairs = [
      {key: 'foo1', value: '{ "name": "foo1", "url": "http://localhost:3000", "created": "0" ,"tenantId": "' + tenantId + '" }'},
      {key: 'foo2', value: '{ "name": "foo2", "url": "http://localhost:3001", "created": "1", "tenantId": "' + tenantId + '" }'},
      {key: 'foo3', value: 'not valid json'}
    ];

    keyValuePairs.forEach(function(obj) {
      client._client.set(client._etcDirectory + '/' + tenantId + '/' + obj.key, obj.value);
    });
  });

  it('#findAll', function(done){  
    client.findAll(tenantId, function(err, results) {
      assert.equal(results.length, 2);
      results.forEach(function(result) {
        assert.ok(result.name);
        assert.ok(result.url); 
        assert.ok(result.created);
      });  

      done();
    });
  });
  
  it('#get', function(done){
    client.get(tenantId, 'foo1', function(err, result) {
      assert.equal(result, 'http://localhost:3000');
      done();   
    });  
  });

  it('#add', function(done){
    var target = 'foo3';
    var url = 'http://localhost:3003';
    client.add(tenantId, target, url, function(err) {
      assert.ok(!err);
      var kvp = client._client.keyValuePairs['router']['zetta'][tenantId]['foo3'];
      client._client.get(client._etcDirectory + '/' + tenantId + '/foo3', function(err, result) {
        var obj = JSON.parse(result.node.value);
        
        assert.equal(target, obj.name);
        assert.equal(url, obj.url);
        done();  
      });
    });      
  });
  
  it('#remove', function(done){
    var target = 'foo1';
    client.remove(tenantId, target, function(err) {
      assert.ok(!err);
      
      var keys = Object.keys(client._client.keyValuePairs['router']['zetta'][tenantId]);
      assert.equal(keys.length, 2);
      assert.equal(keys.indexOf(target), -1);
      done();
    }); 
  });

  it('emits change events', function(done) {
    var value = [{ "value": '{"type":"cloud-target-1","url":"http://example.com","created":"2015-03-13T20:05:52.177Z","version":"0"}'}, { "value": '{"type":"cloud-target","url":"http://example.com","created":"2015-03-13T20:05:52.177Z","version":"0"}'}]; 
    client._client.keyValuePairs[client._etcDirectory + '/' + tenantId] = value;

    client.on('change', function() {
      done();  
    });    

    client._client._trigger(client._etcDirectory, '{"foo":"foo"}');
  });
});
