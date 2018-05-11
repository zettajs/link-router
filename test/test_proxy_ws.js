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
var request = require('supertest');
var zetta = require('zetta');
var zrx = require('zrx');
var Photocell = require('zetta-photocell-mock-driver');
var StatsClient = require('stats-client');
var WebSocket = require('ws');
var querystring = require('querystring');
var url = require('url');

var MemoryDeviceRegistry = require('./mocks/memory_device_registry');
var MemoryPeerRegistry = require('./mocks/memory_peer_registry');
var MockEtcd = require('./mocks/mock_etcd');
var VersionClient = require('../version_client');
var ServiceRegistryClient = require('../service_registry_client');
var RouterClient = require('../router_client');
var TargetMonitor = require('../monitor/service');
var Proxy = require('../proxy');
var ExampleDriver = require('./mocks/example_driver')

describe('Proxy Websockets', function() {
  var hub = null;
  var proxy = null;
  var etcd = null;
  var target = null;
  var proxyUrl = null;
  var newTarget = null;
  var serviceRegistryClient = null;
  var validTopics = [];
  var devices = [];

  beforeEach(function(done) {
    devices = [];
    validTopics = [];
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
    hub.use(ExampleDriver);

    target.listen(0, function(err) {
      if(err) {
        return done(err);
      }

      var cloud = 'http://localhost:' + target.httpServer.server.address().port;
      serviceRegistryClient.add('cloud-target', cloud, '1');

      var statsClient = new StatsClient('localhost:8125');
      var monitor = new TargetMonitor(serviceRegistryClient, { disabled: true });
      proxy = new Proxy(serviceRegistryClient, routerClient, versionClient, statsClient, monitor);
      proxy.listen(0, function(err) {
        if(err) {
          return done(err);
        }

        proxyUrl = 'http://localhost:' + proxy._server.address().port;

        hub.link(proxyUrl);

        hub.listen(0, function() {
          var called = false;
          Object.keys(hub.runtime._jsDevices).forEach(function(id) {
            var device = hub.runtime._jsDevices[id];
            if(device.type == 'testdriver') {
              devices.push(device);
              validTopics.push('hub.1' + '/' + device.type + '/' + device.id + '/state');
            }
          });
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




  it('Passing filterMultiple options to ws only one data event will be sent', function(done) {
    var ws = new WebSocket(proxyUrl.replace('http', 'ws') + '/events?filterMultiple=true');
    var topic = validTopics[0];
    ws.on('open', function() {
      var msg = { type: 'subscribe', topic: topic };
      var msg2 = { type: 'subscribe', topic: 'hub.1/testdriver/*/state' };
      ws.send(JSON.stringify(msg));
      ws.send(JSON.stringify(msg2));
      var subscriptions = {};
      ws.on('message', function(buffer) {
        var json = JSON.parse(buffer);
        if(json.type === 'subscribe-ack') {
          assert.equal(json.type, 'subscribe-ack');
          assert(json.timestamp);
          assert(json.subscriptionId);
          subscriptions[json.subscriptionId] = 0;
          if (Object.keys(subscriptions).length === 2) {
            setTimeout(function() {
              devices[0].call('change');
            }, 50);
          }
        } else {
          assert(json.timestamp);
          assert.equal(json.topic, topic);
          assert(json.data);
          json.subscriptionId.forEach(function(id) {
            subscriptions[id]++;
          });

          if (subscriptions[1] === 1 && subscriptions[2] === 1) {
            done();
          }
        }
      });
    });
    ws.on('error', done);
  });

  it('Passing filterMultiple options to ws will apply limits for both topics', function(done) {
    var ws = new WebSocket(proxyUrl.replace('http', 'ws') + '/events?filterMultiple=true');
    var topic = validTopics[0];
    var topic2 = 'hub.1/testdriver/*/state';
    ws.on('open', function() {
      
      var msg = { type: 'subscribe', topic: topic, limit: 2 };
      var msg2 = { type: 'subscribe', topic: topic2, limit: 3 };
      ws.send(JSON.stringify(msg));
      ws.send(JSON.stringify(msg2));
      var subscriptions = {};

      ws.on('message', function(buffer) {
        var json = JSON.parse(buffer);
        if(json.type === 'subscribe-ack') {
          assert.equal(json.type, 'subscribe-ack');
          assert(json.timestamp);
          assert(json.subscriptionId);
          subscriptions[json.subscriptionId] = 0;
          if (Object.keys(subscriptions).length === 2) {
            setTimeout(function() {
              devices[0].call('change');
              devices[0].call('prepare');
              devices[0].call('change');
            }, 50);
          }
        } else if (json.type === 'event') {
          assert(json.timestamp);
          assert.equal(json.topic, topic);
          assert(json.data);

          json.subscriptionId.forEach(function(id) {
            subscriptions[id]++;
          });

          if (subscriptions[1] === 2 && subscriptions[2] === 3) {
            done();
          }
          console.log(subscriptions);
        }
      });
    });
    ws.on('error', done);
  });

  it('Passing filterMultiple options to ws will have no effect on topics with caql query', function(done) {
    var ws = new WebSocket(proxyUrl.replace('http', 'ws') + '/events?filterMultiple=true');
    var topic = validTopics[0] + '?select *';
    var topic2 = 'hub.1/testdriver/*/state';
    ws.on('open', function() {
      var msg = { type: 'subscribe', topic: topic };
      var msg2 = { type: 'subscribe', topic: topic2 };
      ws.send(JSON.stringify(msg));
      ws.send(JSON.stringify(msg2));
      var received = 0;

      ws.on('message', function(buffer) {
        var json = JSON.parse(buffer);
        if(json.type === 'subscribe-ack') {
          assert.equal(json.type, 'subscribe-ack');
          assert(json.timestamp);
          assert(json.subscriptionId);
          setTimeout(function() {
            devices[0].call('change');
          }, 50);
        } else if (json.type === 'event') {
          assert(json.timestamp);
          assert(json.data);
          assert.equal(json.subscriptionId.length, 1);
          received++;

          if (received === 2) {
            done();
          }
        }
      });
    });
    ws.on('error', done);
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

  it('will properly send close ACK when ws closes', function(done) {
    var c = zrx()
      .load(proxyUrl)
      .peer('hub.1')
      .device(function(d) { return d.type === 'photocell'; })
      .stream('intensity')
      .subscribe(function(data) {
        c.dispose();
        var wsUrl = proxyUrl.replace('http', 'ws') + '/servers/hub.1/events?topic=' + data.topic;
        var ws = new WebSocket(wsUrl);
        ws.on('open', function open() {
          ws.close();
        });
        ws.on('close', function(data, flags) {
          done();
        });
      });
  })

  it('will properly send query parameters via proxy.', function(done) {
      target.httpServer.setupEventSocket = function(ws) {
        var parsedUrl = url.parse(ws.upgradeReq.url);
        var parsed = querystring.parse(parsedUrl.query);
        assert.equal('bar', parsed.foo);
        ws.close();
      }
      var wsUrl = proxyUrl.replace('http', 'ws') + '/servers/hub.1/events?foo=bar&topic=foo/1/bar';
      var ws = new WebSocket(wsUrl);
      ws.on('open', function open() {
      });
      ws.on('close', function(data, flags) {
        done();
      });
  })

  it('will properly send filterMultiple.', function(done) {
      target.httpServer.setupEventSocket = function(ws) {
        var parsedUrl = url.parse(ws.upgradeReq.url);
        var parsed = querystring.parse(parsedUrl.query);
        assert.equal('true', parsed.filterMultiple);
        ws.close();
      }
      var wsUrl = proxyUrl.replace('http', 'ws') + '/servers/hub.1/events?filterMultiple=true&topic=foo/1/bar';
      var ws = new WebSocket(wsUrl);
      ws.on('open', function open() {
      });
      ws.on('close', function(data, flags) {
        done();
      });
  })

  it('will respond to ping requests', function(done) {
    var c = zrx()
      .load(proxyUrl)
      .peer('hub.1')
      .device(function(d) { return d.type === 'photocell'; })
      .stream('intensity')
      .subscribe(function(data) {
        c.dispose();

        var wsUrl = proxyUrl.replace('http', 'ws') + '/servers/hub.1/events?topic=' + data.topic;
        var ws = new WebSocket(wsUrl);
        ws.on('open', function open() {
          ws.ping('Application Data');
          ws.on('pong', function(data, flags) {
            assert.equal(data, 'Application Data');
            done();
          })
        });
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
    var once = false;
    var c = zrx()
      .load(proxyUrl)
      .peer('hub.1')
      .device(function(d) { return d.type === 'photocell'; })
      .stream('intensity')
      .subscribe(function() {
        if (!once) {
          proxy._routerClient.emit('change', []);
          setTimeout(function() {
            assert.equal(Object.keys(proxy._cache).length, 0);
            assert.equal(Object.keys(proxy._subscriptions).length, 0);
            done();
          }, 15)
          once = true;
        }
      });
  });


});
