/*!
 * koa-userauth - index.js
 * Copyright(c) 2014 dead_horse <dead_horse@qq.com>
 * MIT Licensed
 */

'use strict';

/**
 * Module dependencies.
 */

var debug = require('debug')('koa-userauth');
var path = require('path');
var is = require('is-type-of');
var copy = require('copy-to');
var urlparse = require('url').parse;
var route = require('path-match')({
  end: false,
  strict: false,
  sensitive: false
});

var defaultOptions = {
  userField: 'user',
  rootPath: '/',
  loginPath: '/login',
  logoutPath: '/logout'
};

/**
 * User auth middleware.
 *
 * @param {String|Regex|Function(pathname, ctx)} match, detect which url need to check user auth.
 * @param {Object} [options]
 *  - {Function(url, rootPath)} loginURLForamter, format the login url.
 *  - {String} [rootPath], custom app url root path, default is '/'.
 *  - {String} [loginPath], default is '/login'.
 *  - {String} [loginCallbackPath], default is `options.loginPath + '/callback'`.
 *  - {String} [logoutPath], default is '/logout'.
 *  - {String} [userField], logined user field name on `this.session`, default is 'user', `this.session.user`.
 *  - {Function* (ctx)} getUser, get user function, must get user info with `req`.
 *  - {Function* (ctx, user)} [loginCallback], you can handle user login logic here,return [user, redirectUrl]
 *  - {Function(ctx)} [loginCheck], return true meaning logined. default is `true`.
 *  - {Function* (ctx, user)} [logoutCallback], you can handle user logout logic here.return redirectUrl
 * @return {Function* (next)} userauth middleware
 * @public
 */

module.exports = function (match, options) {
  options = options || {};
  copy(defaultOptions).to(options);

  options.loginCallbackPath = options.loginCallbackPath
    || options.loginPath + '/callback';

  if (options.rootPath !== '/') {
    options.loginPath = path.join(options.rootPath, options.loginPath);
    options.logoutPath = path.join(options.rootPath, options.logoutPath);
    options.loginCallbackPath = path.join(options.rootPath, options.loginCallbackPath);
  }

  options.loginURLForamter = options.loginURLForamter;
  options.getUser = options.getUser;
  options.redirectHandler = options.redirectHandler || defaultRedirectHandler;

  // need login checker
  var needLogin = match;
  if (is.string(match)) {
    needLogin = match = route(match);
  }
  if (is.regExp(match)) {
    needLogin = function (path) {
      return match.test(path);
    };
  }
  if (!is.function(needLogin)) {
    needLogin = function () {};
  }

  options.loginCallback = options.loginCallback || defaultLoginCallback;
  options.logoutCallback = options.logoutCallback || defaultLogoutCallback;
  options.loginCheck = options.loginCheck || defaultLoginCheck;

  var loginHandler = login(options);
  var loginCallbackHandler = loginCallback(options);
  var logoutHandler = logout(options);

  /**
   * login flow:
   *
   * 1. unauth user, redirect to `$loginPath?redirect=$currentURL`
   * 2. user visit `$loginPath`, redirect to `options.loginURLForamter()` return login url.
   * 3. user visit $loginCallbackPath, handler login callback logic.
   * 4. If user login callback check success, will set `req.session[userField]`,
   *    and redirect to `$currentURL`.
   * 5. If login check callback error, next(err).
   * 6. user visit `$logoutPath`, set `req.session[userField] = null`, and redirect back.
   */

  return function* userauth(next) {

    debug('url: %s, loginPath: %s, session exists: %s',
      this.url, options.loginPath, !!this.session);

    // get login path
    if (!this.session || this.path === options.loginPath) {
      debug('match login path');
      return yield* loginHandler.call(this, next);
    }

    // get login callback
    if (this.path === options.loginCallbackPath) {
      debug('match login clalback path');
      return yield* loginCallbackHandler.call(this, next);
    }

    // get logout
    if (this.path === options.logoutPath) {
      debug('match logout path');
      return yield* logoutHandler.call(this, next);
    }

    // ignore not match path
    if (!needLogin(this.path)) {
      debug('not match needLogin path, %j', needLogin(this.path));
      return yield* next;
    }

    if (this.session[options.userField]
      && options.loginCheck(this)) {
      // 4. user logined, next() handler
      debug('already login');
      return yield* next;
    }

    // try to getUser directly
    var user;
    try {
      user = yield* options.getUser(this);
    } catch (err) {
      console.error(err.stack);
    }
    if (!user) {
      debug('can not get user');
      var ctx = this;

      // make next handle a generator
      // so it can use yield* next in redirectHandle
      var nextHandler = (function* () {
        var redirectURL = ctx.url;
        try {
          redirectURL = encodeURIComponent(redirectURL);
        } catch (e) {
          // URIError: URI malformed
          // use source url
        }
        var loginURL = options.loginPath + '?redirect=' + redirectURL;
        debug('redirect to %s', loginURL);
        redirect(ctx, loginURL);
      })();

      return yield* options.redirectHandler.call(this, nextHandler);
    }
    debug('get user directly');
    var res = yield* options.loginCallback(this, user);
    var loginUser = res[0];
    var redirectURL = res[1];
    this.session[options.userField] = loginUser;
    if (redirectURL) {
      return redirect(this, redirectURL);
    }
    yield* next;
  };
};

function* defaultRedirectHandler(nextHandler) {
  yield* nextHandler;
}

function* defaultLoginCallback(ctx, user) {
  return [user, null];
}

function* defaultLogoutCallback(ctx, user, callback) {
  return null;
}

function defaultLoginCheck() {
  return true;
}

/**
 * Send redirect response.
 *
 * @param  {Context} ctx
 * @param  {String} url, redirect URL
 * @param  {Number|String} status, response status code, default is `302`
 *
 * @api public
 */

function redirect(ctx, url, status) {
  if (ctx.accepts('html', 'json') === 'json') {
    ctx.set('Location', url);
    ctx.status = 401;
    ctx.body = {
      error: '401 Unauthorized'
    };
    return;
  }
  return ctx.redirect(url, status);
}

/**
 * formate referer
 * @param {Context} ctx
 * @param {String} pathname
 * @param {String} rootPath
 * @return {String}
 *
 * @api private
 */

function formatReferer(ctx, pathname, rootPath) {
  var query = ctx.query;
  var referer = query.redirect || ctx.get('referer') || rootPath;
  if (referer[0] !== '/') {
    // ignore protocol://xxx/abc
    referer = rootPath;
  } else if (referer.indexOf(pathname) >= 0) {
    referer = rootPath;
  }
  return referer;
}

/**
 * return a loginHandler
 * @param {Object} options
 * @return {Function}
 */

function login(options) {
  var protocol = options.protocol || 'http';
  var defaultHost = options.host;
  return function* loginHandler() {
    var loginCallbackPath = options.loginCallbackPath;
    var loginPath = options.loginPath;
    // this.session should be exists
    if (this.session) {
      this.session._loginReferer = formatReferer(this, loginPath, options.rootPath);
      debug('set loginReferer into session: %s', this.session._loginReferer);
    }

    var host = defaultHost || this.host;
    var currentURL = protocol + '://' + host + loginCallbackPath;
    var loginURL = options.loginURLForamter(currentURL, options.rootPath);
    debug('login redrect to loginURL: %s', loginURL);
    redirect(this, loginURL);
  };
}

/**
 * return a loginCallbackHandler
 * @param {Object} options
 * @return {Function}
 */

function loginCallback(options) {
  return function *loginCallbackHandler() {
    var referer = this.session._loginReferer || options.rootPath;
    var user = this.session[options.userField];
    if (user) {
      // already login
      return redirect(this, referer);
    }
    user = yield* options.getUser(this);
    if (!user) {
      return redirect(this, referer);
    }

    var res = yield *options.loginCallback(this, user);
    var loginUser = res[0];
    var redirectURL = res[1];
    this.session[options.userField] = loginUser;
    if (redirectURL) {
      referer = redirectURL;
    }
    redirect(this, referer);
  };
}

/**
 * return a logoutHandler
 * @param {Object} options
 * @return {Function}
 */

function logout(options) {
  return function* logoutHandler() {
    var referer = formatReferer(this, options.logoutPath, options.rootPath);
    var user = this.session[options.userField];
    if (!user) {
      return redirect(this, referer);
    }

    var redirectURL = yield* options.logoutCallback(this, user);

    this.session[options.userField] = null;
    if (redirectURL) {
      referer = redirectURL;
    }
    redirect(this, referer);
  };
}
