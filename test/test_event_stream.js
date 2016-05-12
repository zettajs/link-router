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
var VersionClient = require('../clients/version_client');
var ServiceRegistryClient = require('../clients/service_registry_client');
var RouterClient = require('../clients/router_client');
var TargetMonitor = require('../monitor/service');
var Proxy = require('../proxy');
var TestDriver = require('./mocks/example_driver');

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
          hub.use(Led);
          hub.use(TestDriver);

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

    it('multiple clients specific topic subscription only receives messages with that topic', function(done) {
      var topic = validTopics[0];
      
      var connected = 0;
      var recv = 0;
      var ws1 = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      ws1.on('open', function() {
        var msg = { type: 'subscribe', topic: topic };
        ws1.send(JSON.stringify(msg));
        var subscriptionId = null;
        ws1.on('message', function(buffer) {
          var json = JSON.parse(buffer);
          if(json.type === 'subscribe-ack') {
            connected++;
            subscriptionId = json.subscriptionId;
            if (connected === 2) {
              setTimeout(function() {
                devices[0].call('turn-on');
              }, 50);
            }
          } else {
            assert.equal(json.topic, topic);
            assert.equal(json.subscriptionId, subscriptionId);
            recv++;
            if (recv === 2) {
              done();
            }
          }
        });
      });
      ws1.on('error', done);

      var ws2 = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      ws2.on('open', function() {
        var msg = { type: 'subscribe', topic: topic };
        ws2.send(JSON.stringify(msg));
        var subscriptionId = null;
        ws2.on('message', function(buffer) {
          var json = JSON.parse(buffer);
          if(json.type === 'subscribe-ack') {
            subscriptionId = json.subscriptionId;
            connected++;
            if (connected === 2) {
              setTimeout(function() {
                devices[0].call('turn-on');
              }, 50);
            }
          } else {
            assert.equal(json.topic, topic);
            assert.equal(json.subscriptionId, subscriptionId);
            recv++;
            if (recv === 2) {
              done();
            }
          }
        });
      });
      ws2.on('error', done);
    });   
    
    it('multiple clients using different topic subscriptions only receive one message per event', function(done) {
      var endpoint = proxyUrl.replace('http:', 'ws:') + baseUrl;
      var topic = validTopics[0];
      
      var connected = 0;
      var recv1 = 0;
      
      var ws1 = new WebSocket(endpoint);
      ws1.on('open', function() {
        var msg = { type: 'subscribe', topic: topic };
        ws1.send(JSON.stringify(msg));
        var subscriptionId = null;
        ws1.on('message', function(buffer) {
          var json = JSON.parse(buffer);
          if(json.type === 'subscribe-ack') {
            connected++;
            subscriptionId = json.subscriptionId;
            if (connected === 2) {
              setTimeout(function() {
                devices[0].call('turn-on');
              }, 50);
            }
          } else {
            assert.equal(json.topic, topic);
            assert.equal(json.subscriptionId, subscriptionId);
            recv1++;
          }
        });
      });
      ws1.on('error', done);

      var recv2 = 0;
      var ws2 = new WebSocket(endpoint);
      ws2.on('open', function() {
        var msg = { type: 'subscribe', topic: 'hub.0/led/*/state' };
        ws2.send(JSON.stringify(msg));
        var subscriptionId = null;
        ws2.on('message', function(buffer) {
          var json = JSON.parse(buffer);
          if(json.type === 'subscribe-ack') {
            subscriptionId = json.subscriptionId;
            connected++;
            if (connected === 2) {
              setTimeout(function() {
                devices[0].call('turn-on');
              }, 50);
            }
          } else {
            assert.equal(json.topic, topic);
            assert.equal(json.subscriptionId, subscriptionId);
            recv2++;
          }
        });
      });
      ws2.on('error', done);

      setTimeout(function() {
        assert.equal(recv1, 1);
        assert.equal(recv2, 1);
        done();
      }, 250);
    });

    it('wildcard server topic subscription only receives messages with that topic', function(done) {
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      var subscriptionId = null;
      var topic = validTopics[0];
      topic = topic.replace('hub.0', '*');
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
            }, 50);
          } else {
            assert.equal(json.type, 'event');
            assert(json.timestamp);
            assert.equal(json.topic, validTopics[0]);
            assert.equal(json.subscriptionId, subscriptionId);
            assert(json.data);
            done();
          }
        });
      });
      ws.on('error', done);
    });  

    it('wildcard topic and static topic subscription will receive messages for both subscriptions', function(done) {
      var endpoint = proxyUrl.replace('http:', 'ws:') + baseUrl;
      var ws = new WebSocket(endpoint);
      var lastSubscriptionId = null;
      var count = 0;
      ws.on('open', function() {
        var msg = { type: 'subscribe', topic: validTopics[0] };
        ws.send(JSON.stringify(msg));
        msg = { type: 'subscribe', topic: 'hub.0/led/*/state' };
        ws.send(JSON.stringify(msg));
        ws.on('message', function(buffer) {
          var json = JSON.parse(buffer);
          if(json.type === 'subscribe-ack') {
            assert.equal(json.type, 'subscribe-ack');
            assert(json.timestamp);
            assert(json.subscriptionId);
            setTimeout(function() {
              devices[0].call('turn-on');
            }, 50);
          } else {
            count++;
            assert.notEqual(lastSubscriptionId, json.subscriptionId);
            lastSubscriptionId = json.subscriptionId;
            assert.equal(json.type, 'event');
            assert(json.timestamp);
            assert.equal(json.topic, validTopics[0]);
            assert(json.data);
            if (count === 2) {
              done();
            }
          }
        });
      });
      ws.on('error', done);
    });

    it('wildcard server topic subscription receives messages from both hubs', function(done) {
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      var subscriptionId = null;
      var topic = '*/led/*/state';
      ws.on('open', function() {
        var msg = { type: 'subscribe', topic: topic };
        ws.send(JSON.stringify(msg));
        var recv = 0;
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
              devices[3].call('turn-on');
            }, 50);
          } else {
            recv++;
            assert.equal(json.type, 'event');
            assert(json.timestamp);
            assert(json.topic);
            assert.equal(json.subscriptionId, subscriptionId);
            assert(json.data);
            if (recv === 2) {
              done();
            }
          }
        });
      });
      ws.on('error', done);
    });

    it('wildcard topic ** will subscribe to all topics for both hubs', function(done) {
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      var subscriptionId = null;
      var topic = '**';

      var neededTopics = [];
      devices.forEach(function(device, idx) {
        var server = (idx < 3) ? 'hub.0' : 'hub.1';
        neededTopics.push(server + '/' + device.type + '/' + device.id + '/' + 'state');
        neededTopics.push(server + '/' + device.type + '/' + device.id + '/' + 'logs');
      });

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
              devices[1].call('turn-on');
              devices[2].call('change');

              devices[3].call('turn-on');
              devices[4].call('turn-on');
              devices[5].call('change');
            }, 250);
          } else {
            assert.equal(json.type, 'event');
            assert(json.timestamp);
            assert(json.topic);
            assert.equal(json.subscriptionId, subscriptionId);
            assert(json.data);
            var idx = neededTopics.indexOf(json.topic);
            assert.notEqual(idx, -1);
            neededTopics.splice(idx, 1);
            if (neededTopics.length === 0) {
              done();
            }
          }
        });
      });
      ws.on('error', done);
    });

    it('wildcard topic for single peer receives all messages for all topics', function(done) {
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      var subscriptionId = null;
      var count = 0;
      var topic = 'hub.0/led/*/state';
      var lastTopic = null;
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
              devices[1].call('turn-on');
            }, 50);
          } else {
            assert.equal(json.type, 'event');
            assert(json.timestamp);
            assert(json.topic);
            assert.notEqual(json.topic, lastTopic);
            lastTopic = json.topic;
            assert.equal(json.subscriptionId, subscriptionId);
            assert(json.data);
            count++;
            if(count === 2) {
              done();
            }
          }
        });
      });
      ws.on('error', done);  
    });

    it('wildcard topic for device id and stream types receives all messages for all topics', function(done) {
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      var subscriptionId = null;
      var count = 0;
      var topic = 'hub.0/led/**';
      var lastTopic = null;
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
              devices[1].call('turn-on');
            }, 50);
          } else {
            assert.equal(json.type, 'event');
            assert(json.timestamp);
            assert(json.topic);
            assert.notEqual(json.topic, lastTopic);
            lastTopic = json.topic;
            assert.equal(json.subscriptionId, subscriptionId);
            assert(json.data);
            count++;
            if(count === 4) {
              done();
            }
          }
        });
      });
      ws.on('error', done);  
    });

    it('subscribing to logs topic on device will get properly formated response', function(done) {
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      var subscriptionId = null;
      var topic = 'hub.0/led/*/logs';
      var lastTopic = null;
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
            }, 50);
          } else {
            assert.equal(json.type, 'event');
            assert(json.timestamp);
            assert(json.topic);
            assert.notEqual(json.topic, lastTopic);
            lastTopic = json.topic;
            assert.equal(json.subscriptionId, subscriptionId);
            assert(json.data);
            assert.equal(json.data.transition, 'turn-on');
            assert(!json.data.transitions);
            assert.deepEqual(json.data.input, []);
            assert(json.data.properties);
            assert(json.data.actions);
            // Check to ensure hrefs are pointed to proxy not target
            assert(json.data.actions[0].href.indexOf(proxyUrl) === 0);
            
            done();
          }
        });
      });
      ws.on('error', done);  
    });

    it('topic that doesnt exist still opens stream', function(done) {
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      var topic = 'blah/foo/1/blah';
      ws.on('open', function() {
        var msg = { type: 'subscribe', topic: topic };
        ws.send(JSON.stringify(msg));
        ws.on('message', function(buffer) {
          var json = JSON.parse(buffer);
          assert.equal(json.type, 'subscribe-ack');
          assert(json.timestamp);
          assert.equal(json.topic, topic);
          assert(json.subscriptionId);
          done();
        });
      });
      ws.on('error', done);
    });

    it('subscription to non existent hub does not return data for that subscriptionId', function(done) {
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      var validTopic = validTopics[0];
      var invalidTopic = validTopic.replace('hub.0/', 'notahub/');
      var invalidSubscriptionId = null;

      ws.on('open', function() {
        ws.send(JSON.stringify({ type: 'subscribe', topic: invalidTopic }));
        ws.send(JSON.stringify({ type: 'subscribe', topic: validTopic }));

        ws.on('message', function(buffer) {
          var json = JSON.parse(buffer);
          if (json.type === 'subscribe-ack') {
            if (json.topic === invalidTopic) {
              invalidSubscriptionId = json.subscriptionId;
            }
            setTimeout(function() {
              devices[0].call('turn-on');
            }, 50)
          } else {
            assert.notEqual(json.subscriptionId, invalidSubscriptionId);
            done();
          }
        });
      });
      ws.on('error', done);
    });

    it('wildcard and specific topic will each publish a message on a subscription', function(done) {
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      var subscriptionId = null;
      var count = 0;
      var ackCount = 0;
      var topicOne = validTopics[0];
      var topicTwo = 'hub.0/led/*/state';
      ws.on('open', function() {
        var msgOne = { type: 'subscribe', topic: topicOne };
        var msgTwo = { type: 'subscribe', topic: topicTwo };
        ws.send(JSON.stringify(msgOne));
        ws.send(JSON.stringify(msgTwo));
        ws.on('message', function(buffer) {
          var json = JSON.parse(buffer);
          if(json.type === 'subscribe-ack') {
            assert.equal(json.type, 'subscribe-ack');
            assert(json.timestamp);
            assert(json.topic);
            assert(json.subscriptionId);
            subscriptionId = json.subscriptionId;
            ackCount++;
            setTimeout(function() {
              for(var i=0; i<11; i++) {
                devices[0].call((i % 2 === 0) ? 'turn-on' : 'turn-off');
              }
            }, 50);
          } else {
            assert.equal(json.type, 'event');
            assert(json.timestamp);
            assert(json.topic);
            assert(json.subscriptionId);
            count++;
            if(count === 2) {
              assert.equal(ackCount, 2);
              done();
            }
          }
        });
      });
      ws.on('error', done);     
    });

    it('adding limit to subscription should limit number of messages received', function(done){
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      var subscriptionId = null;
      var count = 0;
      var topic = validTopics[0];
      var data = null;
      ws.on('open', function() {
        var msg = { type: 'subscribe', topic: topic, limit: 10 };
        ws.send(JSON.stringify(msg));
        ws.on('message', function(buffer) {
          var json = JSON.parse(buffer);
          if(json.type === 'subscribe-ack') {
            assert.equal(json.type, 'subscribe-ack');
            assert(json.timestamp);
            assert(json.topic);
            assert(json.subscriptionId);
            subscriptionId = json.subscriptionId;

            setTimeout(function() {
              for(var i=0; i<11; i++) {
                devices[0].call((i % 2 === 0) ? 'turn-on' : 'turn-off');
              }
            }, 50);
          } else if (json.type !== 'unsubscribe-ack') {
            assert.equal(json.type, 'event');
            assert(json.timestamp);
            assert(json.topic);
            assert(json.subscriptionId, subscriptionId);
            assert(json.data);

            count++;
            if(count === 10) {
              setTimeout(function() {
                assert.equal(count, 10);
                done();
              }, 200)
            }
          }
        });
      });
      ws.on('error', done);  
    });
    
    it('when limit is reached a unsubscribe-ack should be received', function(done){
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      var subscriptionId = null;
      var count = 0;
      var topic = validTopics[0];
      var data = null;
      ws.on('open', function() {
        var msg = { type: 'subscribe', topic: topic, limit: 10 };
        ws.send(JSON.stringify(msg));
        ws.on('message', function(buffer) {
          var json = JSON.parse(buffer);
          if(json.type === 'subscribe-ack') {
            assert.equal(json.type, 'subscribe-ack');
            assert(json.timestamp);
            assert(json.topic);
            assert(json.subscriptionId);
            subscriptionId = json.subscriptionId;
            setTimeout(function() {
              for(var i=0; i<11; i++) {
                devices[0].call((i % 2 === 0) ? 'turn-on' : 'turn-off');
              }
            }, 50);
          } else if(json.type === 'event') {
            assert.equal(json.type, 'event');
            assert(json.timestamp);
            assert(json.topic);
            assert(json.subscriptionId, subscriptionId);
            assert(json.data);
            count++;
          } else if(json.type === 'unsubscribe-ack') {
            assert.equal(json.type, 'unsubscribe-ack');
            assert(json.timestamp);
            assert.equal(json.subscriptionId, subscriptionId);
            assert.equal(count, 10);
            done();
          }
        });
      });
      ws.on('error', done);  
    });

    it('when limit is reached with a query selector a unsubscribe-ack should be received', function(done){
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      var subscriptionId = null;
      var count = 0;
      var topic = 'hub.0/testdriver/' + devices[2].id + '/bar?select data where data >= 5';
      var data = null;
      ws.on('open', function() {
        var msg = { type: 'subscribe', topic: topic, limit: 10 };
        ws.send(JSON.stringify(msg));
        ws.on('message', function(buffer) {
          var json = JSON.parse(buffer);
          if(json.type === 'subscribe-ack') {
            assert.equal(json.type, 'subscribe-ack');
            assert(json.timestamp);
            assert(json.topic);
            assert(json.subscriptionId);
            subscriptionId = json.subscriptionId;
            setTimeout(function() {
              for(var i=0; i<16; i++) {
                devices[2].incrementStreamValue();
              }
            }, 50);
          } else if(json.type === 'event') {
            assert.equal(json.type, 'event');
            assert(json.timestamp);
            assert(json.topic);
            assert(json.subscriptionId, subscriptionId);
            assert(json.data);
            count++;
          } else if(json.type === 'unsubscribe-ack') {
            assert.equal(json.type, 'unsubscribe-ack');
            assert(json.timestamp);
            assert.equal(json.subscriptionId, subscriptionId);
            assert.equal(count, 10);
            done();
          }
        });
      });
      ws.on('error', done);  
    });

    it('query field selector should only return properties in selection', function(done){
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      var subscriptionId = null;
      var count = 0;
      var topic = 'hub.0/testdriver/' + devices[2].id + '/bar?select data where data >= 1';
      ws.on('open', function() {
        var msg = { type: 'subscribe', topic: topic };
        ws.send(JSON.stringify(msg));
        ws.on('message', function(buffer) {
          var json = JSON.parse(buffer);
          if(json.type === 'subscribe-ack') {
            assert.equal(json.type, 'subscribe-ack');
            assert(json.timestamp);
            assert(json.topic);
            assert(json.subscriptionId);
            subscriptionId = json.subscriptionId;
            setTimeout(function() {
              devices[2].incrementStreamValue();
            }, 50);
          } else if(json.type === 'event') {
            assert.equal(json.type, 'event');
            assert(json.timestamp);
            assert(json.topic);
            assert(json.subscriptionId, subscriptionId);
            assert(json.data);
            done();
          }
        });
      });
      ws.on('error', done);  
    });

    it('query field selector * should all properties in selection', function(done){
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      var subscriptionId = null;
      var count = 0;
      var topic = 'hub.0/testdriver/' + devices[2].id + '/fooobject?select * where data.val >= 2';
      var data = { foo: 'bar', val: 2 };
      ws.on('open', function() {
        var msg = { type: 'subscribe', topic: topic };
        ws.send(JSON.stringify(msg));
        ws.on('message', function(buffer) {
          var json = JSON.parse(buffer);
          if(json.type === 'subscribe-ack') {
            assert.equal(json.type, 'subscribe-ack');
            assert(json.timestamp);
            assert(json.topic);
            assert(json.subscriptionId);
            subscriptionId = json.subscriptionId;
            setTimeout(function() {
              devices[2].publishStreamObject(data);
            }, 50);
          } else if(json.type === 'event') {
            assert(json.timestamp);
            assert(json.topic);
            assert(json.subscriptionId, subscriptionId);
            assert(json.data);
            assert.equal(json.data.val, 2);
            assert.equal(json.data.foo, 'bar');
            done();
          }
        });
      });
      ws.on('error', done);  
    });

    it('query field selector should return only selected properties', function(done){
      var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
      var subscriptionId = null;
      var count = 0;
      var topic = 'hub.0/testdriver/' + devices[2].id + '/fooobject?select data.val';
      var data = { foo: 'bar', val: 2 };
      ws.on('open', function() {
        var msg = { type: 'subscribe', topic: topic };
        ws.send(JSON.stringify(msg));
        ws.on('message', function(buffer) {
          var json = JSON.parse(buffer);
          if(json.type === 'subscribe-ack') {
            assert.equal(json.type, 'subscribe-ack');
            assert(json.timestamp);
            assert(json.topic);
            assert(json.subscriptionId);
            subscriptionId = json.subscriptionId;
            setTimeout(function() {
              devices[2].publishStreamObject(data);
            }, 50);
          } else if(json.type === 'event') {
            assert(json.timestamp);
            assert(json.topic);
            assert(json.subscriptionId, subscriptionId);
            assert(json.data);
            assert.equal(json.data.val, 2);
            assert.equal(json.data.foo, undefined);
            done();
          }
        });
      });
      ws.on('error', done);  
    });

    describe('Protocol Errors', function() {

      var makeTopicStringErrorsTest = function(topic) {
        it('invalid stream topic "' + topic + '" should result in a 400 error', function(done){
          var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
          ws.on('open', function() {
            var msg = { type: 'subscribe', topic: topic };
            ws.send(JSON.stringify(msg));
            ws.on('message', function(buffer) {
              var json = JSON.parse(buffer);
              assert(json.timestamp);
              assert.equal(json.topic, topic);
              assert.equal(json.code, 400);
              assert(json.message);
              done();
            });
          });
          ws.on('error', done);  
        });
      };

      makeTopicStringErrorsTest('*');
      makeTopicStringErrorsTest('hub');
      makeTopicStringErrorsTest('{hub.+}');
      makeTopicStringErrorsTest('*/');
      makeTopicStringErrorsTest('**/');
      makeTopicStringErrorsTest('hub/');
      makeTopicStringErrorsTest('{hub.+}/');

      it('invalid stream query should result in a 400 error', function(done){
        var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
        var subscriptionId = null;
        var count = 0;
        var topic = 'hub/testdriver/' + devices[0].id + '/fooobject?invalid stream query';
        var data = { foo: 'bar', val: 2 };
        ws.on('open', function() {
          var msg = { type: 'subscribe', topic: topic };
          ws.send(JSON.stringify(msg));
          ws.on('message', function(buffer) {
            var json = JSON.parse(buffer);
            done();
            assert(json.timestamp);
            assert.equal(json.topic, topic);
            assert.equal(json.code, 400);
            assert(json.message);
          });
        });
        ws.on('error', done);  
      });

      it('invalid subscribe should result in a 400 error', function(done){
        var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
        var subscriptionId = null;
        var count = 0;
        ws.on('open', function() {
          var msg = { type: 'subscribe' };
          ws.send(JSON.stringify(msg));
          ws.on('message', function(buffer) {
            var json = JSON.parse(buffer);
            done();
            assert(json.timestamp);
            assert.equal(json.code, 400);
            assert(json.message);
          });
        });
        ws.on('error', done);  
      });

      it('unsubscribing from an invalid subscriptionId should result in a 400 error', function(done){
        var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
        var subscriptionId = null;
        var count = 0;
        ws.on('open', function() {
          var msg = { type: 'unsubscribe', subscriptionId: 123 };
          ws.send(JSON.stringify(msg));
          ws.on('message', function(buffer) {
            var json = JSON.parse(buffer);
            done();
            assert(json.timestamp);
            assert.equal(json.code, 405);
            assert(json.message);
          });
        });
        ws.on('error', done);  
      });

      it('unsubscribing from a missing subscriptionId should result in a 400 error', function(done){
        var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
        var subscriptionId = null;
        var count = 0;
        ws.on('open', function() {
          var msg = { type: 'unsubscribe' };
          ws.send(JSON.stringify(msg));
          ws.on('message', function(buffer) {
            var json = JSON.parse(buffer);
            done();
            assert(json.timestamp);
            assert.equal(json.code, 400);
            assert(json.message);
          });
        });
        ws.on('error', done);  
      });

      it('on invalid message should result in a 400 error', function(done){
        var ws = new WebSocket(proxyUrl.replace('http:', 'ws:') + baseUrl);
        var subscriptionId = null;
        var count = 0;
        ws.on('open', function() {
          var msg = { test: 123 };
          ws.send(JSON.stringify(msg));
          ws.on('message', function(buffer) {
            var json = JSON.parse(buffer);
            done();
            assert(json.timestamp);
            assert.equal(json.code, 400);
            assert(json.message);
          });
        });
        ws.on('error', done);  
      });


    })

  });
});
