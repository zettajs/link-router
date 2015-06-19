var async = require('async');
var TargetState = require('./target_state');
var targetCheck = require('./target_check');

var Defaults = {
  Interval: 30000,
  Timeout: 10000,
  HealthyTreshold: 2,
  UnhealthyThreshold: 5,
  MaxParrell: 5
};

var MonitorService = module.exports = function(serviceRegistryClient, opts) {
  var self = this;

  if (!opts) {
    opts = {};
  }

  if (!serviceRegistryClient) {
    throw new Error('ServiceRegistryClient must be supplied');
  }
  this.serviceRegistryClient = serviceRegistryClient;

  Object.keys(Defaults).forEach(function(k) {
    self[k] = Defaults[k];
    if (opts.hasOwnProperty(k)) {
      self[k] = opts[k];
    }
  });

  if (!this.log) {
    this.log = console;
  }

  this.state = {}; // { <targetUrl>: TargetState }

  // If disabled don't do anything
  if (opts.disabled === true) {
    return;
  } else {
    this.start();
  }
};

MonitorService.prototype.start = function() {
  clearInterval(this._intervalTimer);
  this._intervalTimer = setInterval(this._run.bind(this), this.Interval);
  this._run();
};

MonitorService.prototype.stop = function() {
  clearInterval(this._intervalTimer);
};

MonitorService.prototype.status = function(targetUrl) {
  if (!this.state.hasOwnProperty(targetUrl)) {
    return 'UNDETERMINED';
  } else {
    return this.state[targetUrl].status;
  }
};

MonitorService.prototype._run = function() {
  var self = this;
  // gather hosts
  // foreach host check and update state

  this.getherHosts(function(err, hosts) {
    if (err) {
      self.log.error('Monitor: Failed to gather targets. ' + err);
      return;
    }
    
    async.eachLimit(hosts, self.MaxParrell, self._updateHost.bind(self), function(err) {});
  });
};

// check and update host state
MonitorService.prototype._updateHost = function(target, callback) {
  if (!this.state.hasOwnProperty(target.url)) {
    this.state[target.url] = new TargetState(this.HealthyThreshold, this.UnHealthyThreshold);
  }

  var state = this.state[target.url];

  var opts = {
    Timeout: this.Timeout
  };
  targetCheck(opts, target, function(result, err) {
    if (result) {
      state.success();
    } else {
      state.fail();
    }
    callback();
  });
};

MonitorService.prototype.gatherHosts = function(callback) {
  this.serviceRegistryClient.findAll(callback);
};

MonitorService.Defaults = Defaults;
