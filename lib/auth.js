'use strict';

var uuid = require('uuid');
var Boom = require('boom');
var conf = require('./conf');

var ban = require('./ban');
var pin = require('./pin');
var fixtures = require('../test/fixtures.json');

var dbs = require('./db');
var db = dbs.register('logins', { ttl: true });
var profdb = dbs('profile');
var bandb = dbs('bans');
var utils = require('./utils');

var addNewUser = function (uid, phone, request, reply) {
  profdb.put('uid!' + uid, phone, function (err) {
    if (err) {
      return reply(Boom.wrap(err, 400));
    }

    profdb.put('user!' + phone, {
      uid: uid,
      phone: phone,
      showreplies: true,
      secondary: {}
    }, function (err) {
      if (err) {
        return reply(Boom.wrap(err, 400));
      }

      request.session.set('uid', uid);
      request.session.set('phone', phone);
      return reply.redirect('/');
    });
  });
};

var checkAdmin = function (uid, request) {
  if (conf.get('ops').indexOf(uid) > -1) {
    request.session.set('op', true);
    return;
  }
};

var register = function (request, reply) {
  // phone number has to stay pre-hashed at this point
  var prehashPhone = utils.fixNumber(request.session.get('phone'));
  var phone = utils.phoneHash(prehashPhone);

  if (process.env.NODE_ENV === 'test') {
    phone = fixtures.phone;
  }

  console.log('logging in ', phone);

  profdb.get('user!' + phone, function (err, user) {
    if (err || !user) {
      // Test secondary phone first before assuming it is a new registration
      profdb.get('secondary!' + phone, function (err, primary) {
        if (err || !primary) {
          // register new user

          if (conf.get('disableSignups')) {
            return reply.redirect('/no_new_accounts');
          } else {
            var uid = uuid.v4();
            addNewUser(uid, phone, request, reply);
          }
        } else {
          profdb.get('user!' + primary, function (err, user) {
            if (err) {
              // This shouldn't happen at all since attaching a secondary phone to
              // a non-existent primary means the data is faulty.
              return reply(Boom.wrap(err, 500));
            }

            checkAdmin(user.uid, request);
            request.session.set('phone', primary);
            request.session.set('uid', user.uid);
            request.session.set('name', user.name);
            return reply.redirect('/');
          });
        }
      });
    } else {
      checkAdmin(user.uid, request);
      // now that we've validated with a PIN, we can convert the session phone to the hashed one
      request.session.set('phone', phone);
      request.session.set('uid', user.uid);
      request.session.set('name', user.name);
      reply.redirect('/');
    }
  });
};

exports.login = function (request, reply) {
  var prehashPhone = request.payload.phone;
  var phone = utils.phoneHash(prehashPhone);
  var ip = request.info.remoteAddress;

  if (!ip) {
    // Only allowed in test mode.
    if (process.env.NODE_ENV === 'test') {
      // just use the phone instead.
      ip = phone;
    } else {
      // srsly, how is this even happening?
      return reply(Boom.wrap(new Error('remote ip required'), 400));
    }
  }

  var generate = function () {
    pin.generate(prehashPhone, function (err) {
      if (err) {
        if (conf.get('disableSignups')) {
          return reply.redirect('/no_new_accounts');
        } else {
          return reply(Boom.wrap(err, 400));
        }
      }

      // set session phone temporarily to the prehashed one so that we can verify auth later
      request.session.set('phone', prehashPhone);
      reply.redirect('/authenticate');
    });
  };

  var getLoginAttempts = function () {
    db.get(phone, function (err, count) {
      if (!err) {
        count++;
        if (count > 3) {
          // ban if there are more than 3 login attempts in a span of 5 minutes
          ban.hammer(ip, function (err) {
            if (err) {
              console.error(err);
            }
          });
          return reply(Boom.wrap(new Error('Your number has been banned. Please contact an operator.'), 400));
        }
      } else {
        count = 0;
      }

      db.put(phone, count, { ttl: 300000 }, function (err) {
        if (err) {
          return reply(Boom.wrap(err, 400));
        }

        generate();
      });
    });
  };

  bandb.get(ip, function (err) {
    if (!err) {
      return reply(Boom.wrap(new Error('Your number has been banned. Please contact an operator.'), 400));
    }

    getLoginAttempts();
  });
};

exports.authenticate = function (request, reply) {
  // still using the real phone number, will convert to hashed one on registration
  var phone = utils.fixNumber(request.session.get('phone'));

  if (process.env.NODE_ENV === 'test') {
    phone = fixtures.phone;
  }

  pin.verify(phone, request.payload.pin, function (err) {
    if (err) {
      return reply(Boom.wrap(err, 400));
    }

    register(request, reply);
  });
};

exports.logout = function (request, reply) {
  request.session.reset();
  reply.redirect('/');
};
