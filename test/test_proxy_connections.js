var assert = require('assert');
var zetta = require('zetta');

var MemoryDeviceRegistry = require('./mocks/memory_device_registry');
var MemoryPeerRegistry = require('./mocks/memory_peer_registry');
var MockEtcd = require('./mocks/mock_etcd');
var VersionClient = require('../version_client');
var ServiceRegistryClient = require('../service_registry_client');
var RouterClient = require('../router_client');
var Proxy = require('../proxy');

describe('Proxy', function() {
  var hub = null;
  var proxy = null;
  var etcd = null;
  var target = null;
  var proxyUrl = null;
  var newTarget = null;
  var serviceRegistryClient = null;
  
  beforeEach(function(done) {
    etcd = new MockEtcd();

    etcd.keyValuePairs['/zetta/version'] = { value: '{"version":"1"}' };
    
    var versionClient = new VersionClient({ client: etcd });
    serviceRegistryClient = new ServiceRegistryClient({ client: etcd });
    var routerClient = new RouterClient({ client: etcd });

    target = zetta({registry: new MemoryDeviceRegistry(), peerRegistry: new MemoryPeerRegistry() });
    hub = zetta({registry: new MemoryDeviceRegistry(), peerRegistry: new MemoryPeerRegistry() });

    target.silent();
    hub.silent();

    target.name('target.1');
    hub.name('hub.1');

    target.listen(0, function(err) {
      if(err) {
        return done(err);
      }

      var cloud = 'http://localhost:' + target.httpServer.server.address().port;
      serviceRegistryClient.add('cloud-target', cloud, '1');

      proxy = new Proxy(serviceRegistryClient, routerClient, versionClient); 
      proxy.listen(0, function(err) {
        if(err) {
          return done(err);
        } 

        proxyUrl = 'http://localhost:' + proxy._server.address().port;

        done();
      });
    });

  });  

  afterEach(function(done) {
    target.httpServer.server.close();
    hub.httpServer.server.close();
    proxy._server.close();
    if(newTarget) {
      newTarget.httpServer.server.close();
    }
    done();  
  });
   
  it('will properly route peering connections', function(done) {
    hub.link(proxyUrl);
    var count = 0;
    function checkConnectionCount() {
      if(count == 2) {
        done(); 
      }  
    }

    hub.pubsub.subscribe('_peer/connect', function(topic, data) {
      count++;
      checkConnectionCount();
    });

    target.pubsub.subscribe('_peer/connect', function(topic, data) {
      count++;
      checkConnectionCount();
    });

    hub.listen(0);
  });

  it('will properly route to new versions.', function(done) {
    var count = 0;
    newTarget = zetta({registry: new MemoryDeviceRegistry(), peerRegistry: new MemoryPeerRegistry() })
    function checkConnectionCount() {
      if(count == 2) {
        done(); 
      }  
    }

    newTarget.name('target.2');
    newTarget.silent();


    newTarget.listen(0, function(err) {
      if(err) {
        return done(err);
      }
      
      var cloud = 'http://localhost:' + newTarget.httpServer.server.address().port;
      serviceRegistryClient.add('cloud-target', cloud, '2');
      etcd.keyValuePairs['/zetta/version'] = { value: '{"version":"2"}' };
      etcd._trigger('/zetta/version', '{"version":"2"}');
      etcd._trigger('/services/zetta', '{"foo":"foo"}');

      hub.pubsub.subscribe('_peer/connect', function(topic, data) {
        count++;
        checkConnectionCount();
      });

      newTarget.pubsub.subscribe('_peer/connect', function(topic, data) {
        count++;
        checkConnectionCount();
      });

      hub.link(proxyUrl);
      hub.listen(0);
    });
      
  });
});
