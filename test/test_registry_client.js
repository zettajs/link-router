var assert = require('assert');
var ServiceRegistryClient = require('../service_registry_client');
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
      var parsedObject = JSON.parse(client._client.keyValuePairs[key].value);
      assert.equal(parsedTest.type, parsedObject.type);
      assert.equal(parsedTest.url, parsedObject.url);
      assert.equal(parsedTest.date, parsedObject.date);
      assert.equal(parsedTest.version, parsedObject.version);
      done(); 
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
    var value = [{ "value": '{"type":"cloud-target","url":"http://example.com","created":"2015-03-13T20:05:52.177Z","version":"0"}'}, { "value": '{"type":"cloud-target","url":"http://example.com","created":"2015-03-13T20:05:52.177Z","version":"0"}'}]; 
    client._client.keyValuePairs[client._etcDirectory] = value;

    client.findAll(function(err, results) {
      assert.equal(results.length, 2);
      done();
    });
  }); 

  it('#find', function(done) {
     var value = [{ "value": '{"type":"cloud-target-1","url":"http://example.com","created":"2015-03-13T20:05:52.177Z","version":"0"}'}, { "value": '{"type":"cloud-target","url":"http://example.com","created":"2015-03-13T20:05:52.177Z","version":"0"}'}]; 
    client._client.keyValuePairs[client._etcDirectory] = value;

    client.find('cloud-target-1', function(err, results) {
      assert.equal(results.length, 1);
      done();
    }); 
  });

  it('emits a change event', function(done) {
    var value = [{ "value": '{"type":"cloud-target-1","url":"http://example.com","created":"2015-03-13T20:05:52.177Z","version":"0"}'}, { "value": '{"type":"cloud-target","url":"http://example.com","created":"2015-03-13T20:05:52.177Z","version":"0"}'}]; 
    client._client.keyValuePairs[client._etcDirectory] = value;

    client.on('change', function() {
      done();  
    });    

    client._client._trigger(client._etcDirectory, '{"foo":"foo"}');
  });
});
