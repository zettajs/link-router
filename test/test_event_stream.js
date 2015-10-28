var assert = require('assert');
var url = require('url');
var request = require('supertest');
var zetta = require('zetta');
var Led = require('zetta-led-mock-driver');
var WebSocket = require('ws');
var StatsClient = require('stats-client');

var MemoryDeviceRegistry = require('./mocks/memory_device_registry');
var MemoryPeerRegistry = require('./mocks/memory_peer_registry');
var MockEtcd = require('./mocks/mock_etcd');
var VersionClient = require('../version_client');
var ServiceRegistryClient = require('../service_registry_client');
var RouterClient = require('../router_client');
var TargetMonitor = require('../monitor/service');
var Proxy = require('../proxy');

function getBody(fn) {
  return function(res) {
    try {
      if(res.text) {
        var body = JSON.parse(res.text);
      } else {
        var body = '';
      }
    } catch(err) {
      throw new Error('Failed to parse JSON body'); 
    }
    
    fn(res, body);  
  }  
}

describe('Event Streams', function() {
  var proxy = null;
  var proxyUrl = null;
  var hubs = [];
  var targets = [];
  var etcd = null;
  var devices = [];
  var validTopics = [];
  
  beforeEach(function(done) {
    etcd = new MockEtcd();

    devices = [];
    validTopics = [];

    etcd.set('/zetta/version', '{"version":"1"}');    
    var versionClient = new VersionClient({ client: etcd });
    var serviceRegistryClient = new ServiceRegistryClient({ client: etcd });
    var routerClient = new RouterClient({ client: etcd });

    // start targets
    var targetsStarted = 0;
    [0, 1].forEach(function(i) {
      var target = zetta({registry: new MemoryDeviceRegistry(), peerRegistry: new MemoryPeerRegistry() });
      targets.push(target);

      target.name('target.' + i)
      target.silent();
      
      target.listen(0, function(err) {
        if(err) {
          return done(err);
        }

        serviceRegistryClient.add('cloud-target', 'http://localhost:' + target.httpServer.server.address().port, '1');
        targetsStarted++;
        if (targetsStarted === 2) {
          startProxy();
        }
      });
    })
    
    function startProxy() {
      var statsClient = new StatsClient('localhost:8125');
      var monitor = new TargetMonitor(serviceRegistryClient, { disabled: true });
      proxy = new Proxy(serviceRegistryClient, routerClient, versionClient, statsClient, monitor);
      proxy.listen(0, function(err) {
        if(err) {
          return done(err);
        } 

        proxyUrl = 'http://127.0.0.1:' + proxy._server.address().port;
        startHubs();
      });
    }

    function startHubs() {
      var hubsStarted = 0;
      [0, 1].forEach(function(i) {
        setTimeout(function() {
          var hub = zetta({registry: new MemoryDeviceRegistry(), peerRegistry: new MemoryPeerRegistry() });
          var hubName = 'hub.' + i;
          hubs.push(hub);
          hub.silent();
          hub.name(hubName);
          hub.link(proxyUrl);
          hub.use(Led);

          hub.listen(0, function(err) {
            if (err) {
              return done(err);
            }

            hub.runtime.pubsub.subscribe('_peer/connect', function() {
              hubsStarted++;
              if (hubsStarted === 2) {
                etcd._trigger('/router/zetta', []);
                done();
              }
            })

            Object.keys(hub.runtime._jsDevices).forEach(function(id) {
              var device = hub.runtime._jsDevices[id];
              devices.push(device);
              validTopics.push(hubName + '/' + device.type + '/' + device.id + '/state');
            });

          });
        }, 100*i);

      })
    }

  });  

  describe('Websocket API', function() {

    var baseUrl = '/events';

    it('subscribing to a topic receives a subscription-ack', function(done) {
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      ws.on('open', function() {
        var msg = { type: 'subscribe', topic: 'hub/led/1234/state' };
        ws.send(JSON.stringify(msg));
        ws.on('message', function(buffer) {
          var json = JSON.parse(buffer);
          assert.equal(json.type, 'subscribe-ack');
          assert(json.timestamp);
          assert.equal(json.topic, 'hub/led/1234/state');
          assert(json.subscriptionId);
          done();
        });
      });
      ws.on('error', done);
    });

    it('unsubscribing to a topic receives a unsubscription-ack', function(done) {
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      ws.on('open', function() {
        var msg = { type: 'subscribe', topic: 'hub/led/1234/state' };
        ws.send(JSON.stringify(msg));
        ws.once('message', function(buffer) {
          var json = JSON.parse(buffer);
          var msg = { type: 'unsubscribe', subscriptionId: json.subscriptionId };
          ws.send(JSON.stringify(msg));
          ws.on('message', function(buffer) {
            var json2 = JSON.parse(buffer);  
            assert.equal(json2.type, 'unsubscribe-ack');
            assert(json2.timestamp);
            assert.equal(json2.subscriptionId, json.subscriptionId);
            done();
          });       
        });
      });
      ws.on('error', done);
    });

    it('specific topic subscription only receives messages with that topic', function(done) {
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      var subscriptionId = null;
      var topic = validTopics[0];
      ws.on('open', function() {
        var msg = { type: 'subscribe', topic: topic };
        ws.send(JSON.stringify(msg));
        ws.on('message', function(buffer) {
          var json = JSON.parse(buffer);
          if(json.type === 'subscribe-ack') {
            assert.equal(json.type, 'subscribe-ack');
            assert(json.timestamp);
            assert.equal(json.topic, topic);
            assert(json.subscriptionId);
            subscriptionId = json.subscriptionId;

            setTimeout(function() {
              devices[0].call('turn-on');
            }, 100);
          } else {
            assert.equal(json.type, 'event');
            assert(json.timestamp);
            assert.equal(json.topic, topic);
            assert.equal(json.subscriptionId, subscriptionId);
            assert(json.data);
            done();
          }
        });
      });
      ws.on('error', done);
    });

    
    
  })

});
