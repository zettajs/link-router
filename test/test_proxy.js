var assert = require('assert');
var request = require('supertest');
var Proxy = require('../proxy');
var MockEtcd = require('./mocks/mock_etcd');
var VersionClient = require('../version_client');
var ServiceRegistryClient = require('../service_registry_client');
var RouterClient = require('../router_client');
var StatsClient = require('stats-client');
var TargetMonitor = require('../monitor/service');
var Rels = require('zetta-rels');

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
    var monitor = new TargetMonitor(serviceRegistryClient, { disabled: true });
    proxy = new Proxy(serviceRegistryClient, routerClient, versionClient, statsClient, monitor);
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
    
  });  
  describe('Proxy updates from etcd', function() {
    it('will update the version from an etcd watcher', function() {
      etcd.set('/zetta/version', '{"version":"1"}');
      etcd.set('/zetta/version', '{"version":"2"}');
      etcd._trigger('/zetta/version', '{"version":"2"}');
      assert.equal(proxy._currentVersion, "2");
    });

    it('will update the current routes from an etcd watcher', function() {
      etcd.set('/router/zetta/default', '{"url":"http://example.com/", "tenantId": "default"}');
      etcd.set('/router/zetta/', '{"url":"http://example.com/", "tenantId": "default"}');
      etcd._trigger('/router/zetta', []);
      var routerKeys = Object.keys(proxy._router);
      assert.equal(routerKeys.length, 1);      
    });

    it('will update the current targets from an etcd watcher', function() {
      etcd.set('/services/zetta/foo', '{"url":"http://example.com/", "tenantId": "default"}');
      etcd._trigger('/services/zetta', []);
      assert.equal(Object.keys(proxy._servers).length, 1);
    });
  });

  describe('Version update', function() {
    it('_next should return current version', function(done) {
      etcd.set('/services/zetta/foo', '{"url":"http://example.com/", "tenantId": "default", "version": "1"}');
      etcd.set('/services/zetta/bar', '{"url":"http://hello.com/", "tenantId": "default", "version": "2"}');
      etcd._trigger('/services/zetta', []);
      proxy._next('default', function(err, serverUrl) {
        assert.equal('http://example.com/', serverUrl);
        done();
      })
    })

    it('_next should provision new target when version is updated', function(done) {
      etcd.set('/services/zetta/foo', '{"url":"http://example.com/", "tenantId": "default", "version": "1"}');
      etcd.set('/services/zetta/foo2', '{"url":"http://example2.com/", "tenantId": "default", "version": "1"}');
      etcd.set('/services/zetta/bar', '{"url":"http://hello.com/", "tenantId": "default", "version": "2"}');
      etcd._trigger('/services/zetta', []);
      proxy._next('default', function(err, serverUrl) {
        assert.equal('http://example.com/', serverUrl);
        etcd._trigger('/zetta/version', JSON.stringify({ version: '2'}));
        proxy._next('default', function(err, serverUrl) {
          assert.equal('http://hello.com/', serverUrl);
          done();
        });
      })
    })

    it('_next should return error when no targets match current version', function(done) {
      etcd.set('/services/zetta/foo', '{"url":"http://example.com/", "tenantId": "default", "version": "2"}');
      etcd.set('/services/zetta/bar', '{"url":"http://hello.com/", "tenantId": "default", "version": "2"}');
      etcd._trigger('/services/zetta', []);
      proxy._next('default', function(err, serverUrl) {
        assert(err);
        done();
      })
    })
  })

  describe('Target Allocation', function() {

    it('_next should allocate at most 2 targets', function(done) {
      etcd.set('/services/zetta/foo:3001', JSON.stringify({"type":"cloud-target","url":"http://foo:3001","created":"2015-04-29T17:55:01.000Z","version":"1"}));
      etcd.set('/services/zetta/foo:3002', JSON.stringify({"type":"cloud-target","url":"http://foo:3002","created":"2015-04-29T17:55:01.000Z","version":"1"}));
      etcd.set('/services/zetta/foo:3003', JSON.stringify({"type":"cloud-target","url":"http://foo:3003","created":"2015-04-29T17:55:01.000Z","version":"1"}));
      etcd._trigger('/services/zetta', []);

      var finished = 0;
      function check(err, server) {
        if (err) {
          throw err;
        }
        finished++;
        if (finished === 3) {
          var count = 0;
          Object.keys(etcd.keyValuePairs.services.zetta).forEach(function(key) {
            var target = JSON.parse(etcd.keyValuePairs.services.zetta[key]);
            if (target.tenantId === 'default') {
              count++;
            }
          });

          assert.equal(count, 2);
          done();
        }
      }
      
      proxy._next('default', check);
      proxy._next('default', check);
      proxy._next('default', check);
    })
  })
    
});
