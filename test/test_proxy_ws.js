var assert = require('assert');
var request = require('supertest');
var zetta = require('zetta');
var zrx = require('zrx');
var Photocell = require('zetta-photocell-mock-driver');

var MemoryDeviceRegistry = require('./mocks/memory_device_registry');
var MemoryPeerRegistry = require('./mocks/memory_peer_registry');
var MockEtcd = require('./mocks/mock_etcd');
var VersionClient = require('../version_client');
var ServiceRegistryClient = require('../service_registry_client');
var RouterClient = require('../router_client');
var Proxy = require('../proxy');

describe('Proxy Websockets', function() {
  var hub = null;
  var proxy = null;
  var etcd = null;
  var target = null;
  var proxyUrl = null;
  var newTarget = null;
  var serviceRegistryClient = null;
  
  beforeEach(function(done) {
    etcd = new MockEtcd();

    etcd.set('/zetta/version', '{"version":"1"}');
    
    var versionClient = new VersionClient({ client: etcd });
    serviceRegistryClient = new ServiceRegistryClient({ client: etcd });
    var routerClient = new RouterClient({ client: etcd });

    target = zetta({registry: new MemoryDeviceRegistry(), peerRegistry: new MemoryPeerRegistry() });
    hub = zetta({registry: new MemoryDeviceRegistry(), peerRegistry: new MemoryPeerRegistry() });
    target.silent();
    hub.silent();

    target.name('target.1');
    hub.name('hub.1');
    hub.use(Photocell);

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

        hub.link(proxyUrl);

        hub.listen(0, function() {
          var called = false;
          hub.pubsub.subscribe('_peer/connect', function(topic, data) {
            if (!called) {
              called = true;
              done();
            }
          });
        });
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

  it('will should recieve photocell data', function(done) {
    var c = zrx()
      .load(proxyUrl)
      .peer('hub.1')
      .device(function(d) { return d.type === 'photocell'; })
      .stream('intensity')
      .subscribe(function() {
        c.dispose();
        done();
      });
  })

  it('ws should not disconnect after etcd router updates', function(done) {
    var count = 0;
    var c = zrx()
      .load(proxyUrl)
      .peer('hub.1')
      .device(function(d) { return d.type === 'photocell'; })
      .stream('intensity')
      .subscribe(function() {
        if (count === 0) {
          count++;
          etcd._trigger('/router/zetta', []);        
          setTimeout(function() {
            assert.equal(Object.keys(proxy._cache).length, 1);
            done();
          }, 10);
        }
      });
  })

  it('second ws client connecting should continue to recv data after first client disconnects', function(done) {
    var createClient = function(cb) {
      return zrx()
        .load(proxyUrl)
        .peer('hub.1')
        .device(function(d) { return d.type === 'photocell'; })
        .stream('intensity')
        .subscribe(cb);
    }
    
    var c1Count = 0;
    var c2Count = 0;
    var c1 = createClient(function() { c1Count++; });
    var c2 = createClient(function() { c2Count++; });

    setTimeout(function() {
      c1.dispose();
      c2Count=0;
      setTimeout(function() {
        if (c2Count === 0) {
          throw new Error('Havnt recieved anymore ws messages after first client disconnects')
        }
        done();
      }, 200);
    }, 200)
  });

  it('it should disconnect ws if peer disconnects', function(done) {
    var c = zrx()
      .load(proxyUrl)
      .peer('hub.1')
      .device(function(d) { return d.type === 'photocell'; })
      .stream('intensity')
      .subscribe(function() {
        proxy._routerClient.emit('change', []);
        setTimeout(function() {
          assert.equal(Object.keys(proxy._cache).length, 0);
          assert.equal(Object.keys(proxy._subscriptions).length, 0);
          done();
        }, 5)
      });
  });


});
