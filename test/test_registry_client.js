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
var ServiceRegistryClient = require('../clients/service_registry_client');
var MockEtcd = require('./mocks/mock_etcd');

describe('Registry client', function() {
  var client = null;

  beforeEach(function(done) {
    client = new ServiceRegistryClient({ client: new MockEtcd() });
    done();  
  });

  it('#add', function(done) {
    var key = '/services/zetta/example.com';
    var value = '{"type":"cloud-target","url":"http://example.com","created":"2015-03-13T20:05:52.177Z","version":"0"}';
    client.add('cloud-target', 'http://example.com', '0', function() {
      var keys = Object.keys(client._client.keyValuePairs);
      var parsedTest = JSON.parse(value);
      client._client.get(key, function(err, result) {
        var parsedObject = JSON.parse(result.node.value);
        assert.equal(parsedTest.type, parsedObject.type);
        assert.equal(parsedTest.url, parsedObject.url);
        assert.equal(parsedTest.date, parsedObject.date);
        assert.equal(parsedTest.version, parsedObject.version);
        done(); 
      });
    });
  });  

  it('#remove', function(done) {
    client.add('cloud-target', 'http://example.com', '0', function() {
      client.remove('cloud-target', 'http://example.com', function() {
        var keys = Object.keys(client._client.keyValuePairs);
        assert.equal(keys.length, 1);
        done(); 
      }); 
    });
  });

  it('#findAll', function(done) {
    var values = [
      { key: 'example.com', value: '{"type":"cloud-target","url":"http://example.com","created":"2015-03-13T20:05:52.177Z","version":"0"}'},
    { key: 'example2.com', value: '{"type":"cloud-target","url":"http://example2.com","created":"2015-03-13T20:05:52.177Z","version":"0"}'}
  ]; 
    values.forEach(function(value) {
      client._client.set(client._etcDirectory + '/' + value.key, value.value);
    });

    client.findAll(function(err, results) {
      assert.equal(results.length, 2);
      done();
    });
  }); 

  it('#find', function(done) {
    var values = [
      { key: 'example.com', value: '{"type":"cloud-target-1","url":"http://example.com","created":"2015-03-13T20:05:52.177Z","version":"0"}'},
    { key: 'example2.com', value: '{"type":"cloud-target","url":"http://example2.com","created":"2015-03-13T20:05:52.177Z","version":"0"}'}
  ]; 
    values.forEach(function(value) {
      client._client.set(client._etcDirectory + '/' + value.key, value.value);
    });

    client.find('cloud-target-1', function(err, results) {
      assert.equal(results.length, 1);
      done();
    }); 
  });

  it('emits a change event', function(done) {
    var values = [
      { key: 'example.com', value: '{"type":"cloud-target-1","url":"http://example.com","created":"2015-03-13T20:05:52.177Z","version":"0"}'},
    { key: 'example2.com', value: '{"type":"cloud-target","url":"http://example2.com","created":"2015-03-13T20:05:52.177Z","version":"0"}'}
  ]; 
    values.forEach(function(value) {
      client._client.set(client._etcDirectory + '/' + value.key, value.value);
    });
    client.on('change', function() {
      done();  
    });    

    client._client._trigger(client._etcDirectory, '{"foo":"foo"}');
  });
});
