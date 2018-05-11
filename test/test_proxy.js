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
var Proxy = require('../proxy');
var MockEtcd = require('./mocks/mock_etcd');
var VersionClient = require('../clients/version_client');
var ServiceRegistryClient = require('../clients/service_registry_client');
var RouterClient = require('../clients/router_client');
var StatsClient = require('stats-client');
var Rels = require('zetta-rels');

// Fix for Proxy subscribing to SIGs on every test
process.setMaxListeners(0);

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

describe('Proxy', function() {
  var proxy = null;
  var etcd = null;

  beforeEach(function(done) {
    etcd = new MockEtcd();
    etcd.set('/zetta/version', JSON.stringify({ version: '1'}));
    etcd.mkdir('/services/zetta');
    etcd.mkdir('/router/zetta');
    etcd.keyValuePairs['/services/zetta'] = [];
    etcd.keyValuePairs['/router/zetta'] = [];
    var versionClient = new VersionClient({ client: etcd });
    var serviceRegistryClient = new ServiceRegistryClient({ client: etcd });
    var routerClient = new RouterClient({ client: etcd });
    var statsClient = new StatsClient('localhost:8125');
    proxy = new Proxy(serviceRegistryClient, routerClient, versionClient, statsClient);
    proxy.listen(0);
    done();
  });

  afterEach(function(done) {
    proxy._server.close();  
    done();
  });

  describe('request routing', function() {
    it('will properly route to the root request', function(done) {
      request(proxy._server)
        .get('/')
        .expect('Access-Control-Allow-Origin', '*', done);
    });

    it('root req will contain action to query', function(done) {
      request(proxy._server)
        .get('/')
        .expect(getBody(function(res, body) {
          assert.equal(body.actions.length, 1);
          var action = body.actions[0];
          assert.equal(action.name, 'query-devices');
          assert.equal(action.method, 'GET');
          assert.equal(action.type, 'application/x-www-form-urlencoded');
          assert.equal(action.fields.length, 2);
        }))
        .expect(200)
        .end(done);
    });

    it('will have events link on root with proper rel', function(done) {
      request(proxy._server)
        .get('/')
        .expect(getBody(function(res, body) {
          var links = body.links.filter(function(link) {
            return link.rel.indexOf(Rels.events) > -1;
          });
          
          assert.equal(links.length, 1);
        }))
        .end(done);
    });

    it('will have /peer-management link on root with proper rel', function(done) {
      request(proxy._server)
        .get('/')
        .expect(getBody(function(res, body) {
          var links = body.links.filter(function(link) {
            return link.rel.indexOf(Rels.peerManagement) > -1;
          });
          
          assert.equal(links.length, 1);
        }))
        .end(done);
    });

    it('will have servers within the router in the API response', function(done) {
      etcd.set('/router/zetta/default/foo', '{"url":"http://example.com/", "name": "foo", "tenantId": "default"}');
      etcd._trigger('/router/zetta/default', []);
      request(proxy._server)
        .get('/')
        .expect(getBody(function(res, body) {
          assert.equal(body.links.length, 4);
          var peerLink = body.links[3];
          assert.equal(peerLink.title, "foo");
        }))
        .end(done);
    });

    it('will have a list of links.', function(done) {
       request(proxy._server)
        .get('/')
        .expect(getBody(function(res, body) {
          assert.ok(Array.isArray(body.links));  
        }))
        .end(done);
    });

    it('will have a class of root', function(done) {
      request(proxy._server)
        .get('/')
        .expect(getBody(function(res, body) {
          assert.equal(body.class[0], 'root');  
        }))
        .end(done);  
    });

    it('will only have a self link', function(done) {
      request(proxy._server)
        .get('/')
        .expect(getBody(function(res, body) {
          var selfLink = body.links[0];
          assert.equal(body.links.length, 3);
          assert.notEqual(selfLink.rel.indexOf('self'), -1);
        }))
        .end(done);
    });

    it('will have Content-Type header response', function(done) {
      request(proxy._server)
        .get('/')
        .expect('Content-Type', 'application/vnd.siren+json')
        .expect(200)
        .end(done);
    })

    it('will have Content-Length header response', function(done) {
      request(proxy._server)
        .get('/')
        .expect('Content-Length', /[0-9]/)
        .expect(200)
        .end(done);
    })

    it('events link will be ws', function(done) {
      request(proxy._server)
        .get('/')
        .expect(getBody(function(res, body) {
          var eventsLink = body.links.filter(function(link) {
            return link.rel.indexOf(Rels.events) === 0;
          })[0];
          assert(eventsLink.href.indexOf('ws://') === 0);
        }))
        .end(done);  
    });
    
  });  
  describe('Proxy updates from etcd', function() {
    it('will update the version from an etcd watcher', function() {
      etcd.set('/zetta/version', '{"version":"1"}');
      etcd.set('/zetta/version', '{"version":"2"}');
      etcd._trigger('/zetta/version', '{"version":"2"}');
      assert.equal(proxy._currentVersion, "2");
    });

    it('will update the current routes from an etcd watcher', function(done) {
      etcd.set('/router/zetta/default', '{"url":"http://example.com/", "name": "some-peer", "tenantId": "default"}');
      proxy.once('router-update', function(routerCache) {
        assert.equal(routerCache.get('default', 'some-peer'), 'http://example.com/');
        done();
      });
      etcd._trigger('/router/zetta', []);
    });

    it('will update the current targets from an etcd watcher', function() {
      etcd.set('/services/zetta/foo', '{"url":"http://example.com/", "tenantId": "default"}');
      etcd._trigger('/services/zetta', []);
      assert.equal(Object.keys(proxy._servers).length, 1);
    });
  });

    
});
