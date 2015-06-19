var assert = require('assert');
var MockEtcd = require('./mocks/mock_etcd');
var ServiceRegistryClient = require('../service_registry_client');
var MonitorService = require('../monitor/service');
var TargetState = require('../monitor/target_state');

describe('Target Monitor', function() {
  var etcd = null;
  var serviceRegistryClient = null;

  beforeEach(function(done) {
    etcd = new MockEtcd();
    etcd.set('/zetta/version', JSON.stringify({ version: '1'}));
    etcd.mkdir('/services/zetta');
    etcd.mkdir('/router/zetta');
    etcd.keyValuePairs['/services/zetta'] = [];
    etcd.keyValuePairs['/router/zetta'] = [];
    serviceRegistryClient = new ServiceRegistryClient({ client: etcd });
    done();
  });

  afterEach(function(done) {
    done();
  });

  describe('Constructor Options', function() {

    it('without options defaults will be used', function() {
      var monitor = new MonitorService(serviceRegistryClient, { disabled: true });
      Object.keys(MonitorService.Defaults).forEach(function(k) {
        assert.equal(monitor[k], MonitorService.Defaults[k]);
      });
    });

    it('allow overide of options', function() {
      var monitor = new MonitorService(serviceRegistryClient, { disabled: true, Interval: 60000 });
      assert.equal(monitor.Interval, 60000);
    });

    it('gatherHosts return all etcd hosts', function(done) {
      etcd.set('/services/zetta/foo', '{"url":"http://example.com/", "tenantId": "default", "version": "1"}');
      etcd.set('/services/zetta/bar', '{"url":"http://hello.com/", "tenantId": "default", "version": "2"}');
      var monitor = new MonitorService(serviceRegistryClient, { disabled: true });
      monitor.gatherHosts(function(err, hosts) {
        assert(!err);
        assert.equal(hosts.length, 2);
        done();
      });
    });

    it('_updateTarget should set state', function(done) {
      var target = { url: 'http://localhost:1', version: "1" };
      var monitor = new MonitorService(serviceRegistryClient, { disabled: true });
      monitor._updateHost(target, function() {
        assert.equal(monitor.status(target.url), 'DOWN')
        done();
      });
    });

  });

  describe('Target State', function() {

    it('Starts in undetermined state', function() {
      var state = new TargetState();
      assert.equal(state.status, 'UNDETERMINED');
    })

    it('Constructor takes healthy/unhealthy thresholds', function() {
      var state = new TargetState(5,6);
      assert.equal(state.HealthyThreshold, 5);
      assert.equal(state.UnhealthyThreshold, 6);
    })

    it('success change state to UP if started in undetermined state', function() {
      var state = new TargetState(2, 2);
      state.success();
      assert.equal(state.status, 'UP');
      state.success();
      assert.equal(state.status, 'UP');
    })

    it('fail change state to DOWN if started in undetermined state', function() {
      var state = new TargetState(2, 2);
      state.fail();
      assert.equal(state.status, 'DOWN');
      state.fail();
      assert.equal(state.status, 'DOWN');
    })

    it('from DOWN state one success should still keep it in the DOWN state', function() {
      var state = new TargetState(2, 2);
      state.fail();
      state.fail();
      assert.equal(state.status, 'DOWN');
      state.success();
      assert.equal(state.status, 'DOWN');
      state.success();
      assert.equal(state.status, 'UP');
    })

    it('from UP state one success should still keep it in the UP state', function() {
      var state = new TargetState(2, 2);
      state.success();
      state.success();
      assert.equal(state.status, 'UP');
      state.fail();
      assert.equal(state.status, 'UP');
      state.fail();
      assert.equal(state.status, 'DOWN');
    })
  })

});
