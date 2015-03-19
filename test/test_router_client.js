var assert = require('assert');
var RouterClient = require('./../router_client');
var MockEtcd = require('./mocks/mock_etcd');

describe('Router client', function() {
  var client = null;

  beforeEach(function() {
    client = new RouterClient({ client: new MockEtcd });  
    var keyValuePairs = [{value: '{ "name": "foo1", "url": "http://localhost:3000", "created": "0" }'}, {value: '{ "name": "foo2", "url": "http://localhost:3001", "created": "1" }'}];

    client._client.keyValuePairs[client._etcDirectory] = keyValuePairs;

    client._client.keyValuePairs[client._etcDirectory + '/foo1'] = keyValuePairs[0];
    client._client.keyValuePairs[client._etcDirectory + '/foo2'] = keyValuePairs[1];
  });

  it('#findAll', function(done){  
    client.findAll(function(err, results) {
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
    client.get('foo1', function(err, result) {
      assert.equal(result, 'http://localhost:3000');
      done();   
    });  
  });

  it('#add', function(done){
    var target = 'foo3';
    var url = 'http://localhost:3003';
    client.add(target, url, function(err) {
      assert.ok(!err);
      var kvp = client._client.keyValuePairs[client._etcDirectory + '/foo3'];
      var obj = JSON.parse(kvp.value);
      
      assert.equal(target, obj.name);
      assert.equal(url, obj.url);
      done();  
    });      
  });
  
  it('#remove', function(done){
    var target = 'foo1';
    client.remove(target, function(err) {
      assert.ok(!err);
      
      var keys = Object.keys(client._client.keyValuePairs);
      
      assert.equal(keys.length, 2);
      
      assert.equal(keys.indexOf(target), -1);  

      done();
    }); 
  });
});
