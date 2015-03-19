var assert = require('assert');
var VersionClient = require('../version_client');
var MockEtcd = require('./mocks/mock_etcd');

describe('Version client', function() {
  var client = null;
  
  beforeEach(function(done) {
    client = new VersionClient({ client: new MockEtcd() });
    done();  
  });  
  
  it('#get', function(done) {
    var version =  { value: '{"version":"1"}'};
    client._client.keyValuePairs[client._etcdDirectory] = version;
    
    client.get(function(err, version) {
      assert.equal(version.version, '1');
      done();
    });   
  });

  it('emits change event', function(done) {
    var version = { value: '{"version":"1"}'};
    client._client.keyValuePairs[client._etcdDirectory] = version;
    
    client.on('change', function() {
      done();
    });   

    client._client._trigger('/zetta/version', '{"version":"foo"}');
  });
});
