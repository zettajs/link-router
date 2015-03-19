var assert = require('assert');
var MockEtcd = require('./mocks/mock_etcd');
var VersionClient = require('../version_client');
var ServiceRegistryClient = require('../service_registry_client');
var RouterClient = require('../router_client');
var Proxy = require('../proxy');

describe('Proxy', function() {
  var proxy = null;
  
  beforeEach(function(done) {
    var versionClient = new VersionClient({ client: new MockEtcd() });
    var serviceRegistryClient = new ServiceRegistryClient({ client: new MockEtcd() });
    var routerClient = new RouterClient({ client: new MockEctd() });
    proxy = new Proxy(serviceRegistryClient, routerClient, versionClient); 


  });  

});
