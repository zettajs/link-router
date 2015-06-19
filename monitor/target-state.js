var State = module.exports =  function(HealthyTreshold, UnhealthyThreshold) {
  this.HealthyTreshold = HealthyTreshold;
  this.UnhealthyTreshold = UnhealthyTreshold;

  this.lastCheck = null;
  this.lastSeen = null;
  this.count = 0;
  this.status = 'DOWN';
};

State.prototype.success = function() {
  this.lastCheck = new Date();
  this.lastSeen = this.lastCheck;

  // Was in failed state
  if (this.count < 0) {
    this.count = 1;
    this.status = 'RISING';
  } else {
    this.count++;
  }

};
State.prototype.fail = function() {
  this.lastCheck = new Date();
};
