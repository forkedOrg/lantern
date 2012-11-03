'use strict';

angular.module('app.services', [])
  // primitives wrapped in objects for mutatability
  .value('dev', {value: true}) // controls debug logging and developer panel
  .value('sanity', {value: true}) // triggers failure mode when false
  .constant('MODEL_SYNC_CHANNEL', '/sync')
  .constant('APIVER_REQUIRED', {major: 0, minor: 0})
  .constant('googOauthUrl',
    'https://accounts.google.com/o/oauth2/auth?'+
    '&response_type=code'+
    '&client_id=826174845383.apps.googleusercontent.com'+
    '&redirect_uri='+encodeURIComponent('urn:ietf:wg:oauth:2.0:oob')+
    '&scope='+encodeURIComponent('https://www.googleapis.com/auth/googletalk')+
    '&approval_prompt=auto')
  // enums
  .constant('EXTERNAL_URL', {
    helpTranslate: 'https://github.com/getlantern/lantern/wiki/Contributing#wiki-other-languages',
    httpsEverywhere: 'https://www.eff.org/https-everywhere',
    fakeOauth: '/app/fakeOauth.html'
  })
   // XXX use some kind of Object.fromkeys function
  .constant('SETTING', {
    lang: 'lang',
    mode: 'mode',
    autoReport: 'autoReport',
    autoStart: 'autoStart',
    systemProxy: 'systemProxy',
    proxyAllSites: 'proxyAllSites',
    proxyPort: 'proxyPort',
    proxiedSites: 'proxiedSites',
    advertiseLantern: 'advertiseLantern'
  })
  .constant('MODE', {
    give: 'give',
    get: 'get'
  })
  .constant('STATUS_GTALK', {
    notConnected: 'notConnected',
    connecting: 'connecting',
    connected: 'connected'
  })
  .constant('MODAL', {
    passwordCreate: 'passwordCreate',
    settingsUnlock: 'settingsUnlock',
    settingsLoadFailure: 'settingsLoadFailure',
    welcome: 'welcome',
    authorize: 'authorize',
    gtalkUnreachable: 'gtalkUnreachable',
    authorizeLater: 'authorizeLater',
    notInvited: 'notInvited',
    requestInvite: 'requestInvite',
    requestSent: 'requestSent',
    firstInviteReceived: 'firstInviteReceived',
    proxiedSites: 'proxiedSites',
    systemProxy: 'systemProxy',
    inviteFriends: 'inviteFriends',
    finished: 'finished',
    contactDevs: 'contactDevs',
    settings: 'settings',
    confirmReset: 'confirmReset',
    giveModeForbidden: 'giveModeForbidden',
    about: 'about',
    none: ''
  })
  .constant('INTERACTION', {
    inviteFriends: 'inviteFriends',
    contactDevs: 'contactDevs',
    settings: 'settings',
    confirmReset: 'confirmReset',
    proxiedSites: 'proxiedSites',
    about: 'about',
    update: 'update',
    tryAnotherUser: 'tryAnotherUser',
    requestInvite: 'requestInvite',
    retryNow: 'retryNow',
    retryLater: 'retryLater',
    cancel: 'cancel',
    continue: 'continue',
    close: 'close'
  })
  .service('ENUMS', function(MODE, STATUS_GTALK, MODAL, INTERACTION, SETTING, EXTERNAL_URL) {
    return {
      MODE: MODE,
      STATUS_GTALK: STATUS_GTALK,
      MODAL: MODAL,
      INTERACTION: INTERACTION,
      SETTING: SETTING,
      EXTERNAL_URL: EXTERNAL_URL
    };
  })
  // more flexible log service
  // https://groups.google.com/d/msg/angular/vgMF3i3Uq2Y/q1fY_iIvkhUJ
  .value('logWhiteList', /.*Ctrl|.*Srvc/)
  .factory('logFactory', function($log, dev, logWhiteList) {
    return function(prefix) {
      var match = prefix
        ? prefix.match(logWhiteList)
        : true;
      function extracted(prop) {
        if (!match) return angular.noop;
        return function() {
          var args = [].slice.call(arguments);
          prefix && args.unshift('[' + prefix + ']');
          $log[prop].apply($log, args);
        };
      }
      var logLogger = extracted('log');
      return {
        log:   logLogger,
        warn:  extracted('warn'),
        error: extracted('error'),
        debug: function() { if (dev.value) logLogger.apply(logLogger, arguments); }
      };
    }
  })
  .constant('COMETDURL', location.protocol+'//'+location.host+'/cometd')
  .service('cometdSrvc', function(COMETDURL, logFactory, $rootScope, $window) {
    var log = logFactory('cometdSrvc');
    // boilerplate cometd setup
    // http://cometd.org/documentation/cometd-javascript/subscription
    var cometd = $.cometd,
        connected = false,
        clientId,
        subscriptions = [];
    cometd.configure({
      url: COMETDURL,
      backoffIncrement: 50,
      maxBackoff: 500,
      //logLevel: 'debug',
      // XXX necessary to work with Faye backend when browser lacks websockets:
      // https://groups.google.com/d/msg/faye-users/8cr_4QZ-7cU/sKVLbCFDkEUJ
      appendMessageTypeToURL: false
    });
    //cometd.websocketsEnabled = false; // XXX can we re-enable in Lantern?

    // http://cometd.org/documentation/cometd-javascript/subscription
    cometd.onListenerException = function(exception, subscriptionHandle, isListener, message) {
      log.error('Uncaught exception for subscription', subscriptionHandle, ':', exception, 'message:', message);
      if (isListener) {
        cometd.removeListener(subscriptionHandle);
        log.error('removed listener');
      } else {
        cometd.unsubscribe(subscriptionHandle);
        log.error('unsubscribed');
      }
    };

    cometd.addListener('/meta/connect', function(msg) {
      if (cometd.isDisconnected()) {
        connected = false;
        log.debug('connection closed');
        return;
      }
      var wasConnected = connected;
      connected = msg.successful;
      if (!wasConnected && connected) { // reconnected
        log.debug('connection established');
        $rootScope.$broadcast('cometdConnected');
        // XXX why do docs put this in successful handshake callback?
        cometd.batch(function(){ refresh(); });
      } else if (wasConnected && !connected) {
        log.warn('connection broken');
        $rootScope.$broadcast('cometdDisconnected');
      }
    });

    // backend doesn't send disconnects, but just in case
    cometd.addListener('/meta/disconnect', function(msg) {
      log.debug('got disconnect');
      if (msg.successful) {
        connected = false;
        log.debug('connection closed');
        $rootScope.$broadcast('cometdDisconnected');
        // XXX handle disconnect
      }
    });

    function subscribe(channel, callback) {
      var sub = null;
      if (connected) {
        sub = cometd.subscribe(channel, callback);
        log.debug('subscribed to channel', channel);
      } else {
        log.debug('queuing subscription request for channel', channel)
      }
      var key = {sub: sub, chan: channel, cb: callback};
      subscriptions.push(key);
    }

    function unsubscribe(subscription) {
      cometd.unsubscribe(subscription);
      log.debug('unsubscribed', subscription);
    }

    function refresh() {
      log.debug('refreshing subscriptions');
      angular.forEach(subscriptions, function(key) {
        if (key.sub)
          unsubscribe(key.sub);
      });
      var tmp = subscriptions;
      subscriptions = [];
      angular.forEach(tmp, function(key) {
        subscribe(key.chan, key.cb);
      })
    }

    cometd.addListener('/meta/handshake', function(handshake) {
      if (handshake.successful) {
        log.debug('successful handshake', handshake);
        clientId = handshake.clientId;
        //cometd.batch(function(){ refresh(); }); // XXX moved to connect callback
      }
      else {
        log.warn('unsuccessful handshake');
        clientId = null;
      }
    });

    $($window).unload(function() {
      cometd.disconnect(true);
    });

    cometd.handshake();

    return {
      subscribe: subscribe,
      // just for the developer panel
      publish: function(channel, data) { cometd.publish(channel, data); }
    };
  })
  /*
  .service('modelSchema', function(ENUMS) {...})
  .service('modelValidatorSrvc', function(modelSchema, logFactory) {...})
  */
  .service('modelSrvc', function($rootScope, MODEL_SYNC_CHANNEL, cometdSrvc, logFactory) {
    var log = logFactory('modelSrvc'),
        model = {},
        lastModel = {};

    function get(obj, path) {
      var val = obj;
      angular.forEach(path.split('.'), function(name) {
        if (name && typeof val != 'undefined')
          val = val[name];
      });
      return val;
    }

    function set(obj, path, value) {
      if (!path) return angular.copy(value, obj);
      var lastObj = obj, property;
      angular.forEach(path.split('.'), function(name) {
        if (name) {
          lastObj = obj;
          obj = obj[property=name];
          if (typeof obj == 'undefined') {
            lastObj[property] = obj = {};
          }
        }
      });
      lastObj[property] = angular.copy(value);
    }

    function handleSync(msg) {
      // XXX use modelValidatorSrvc to validate update before accepting
      var data = msg.data;
      set(model, data.path, data.value);
      set(lastModel, data.path, data.value);
      $rootScope.$apply();
      log.debug('handleSync applied sync: path:', data.path || '""', 'value:', data.value);
    }

    cometdSrvc.subscribe(MODEL_SYNC_CHANNEL, handleSync);

    return {
      model: model,
      get: function(path){ return get(model, path); },
      // just for the developer panel
      lastModel: lastModel
    };
  })
  .value('apiVerLabel', {value: undefined})
  .service('apiSrvc', function(apiVerLabel) {
    return {
      urlfor: function(endpoint, params) {
          var query = _.reduce(params, function(acc, val, key) {
              return acc+key+'='+encodeURIComponent(val)+'&';
            }, '?');
          return '/api/'+apiVerLabel.value+'/'+endpoint+query;
        }
    };
  });
