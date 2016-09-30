/**
 * Routes Configuration
 * (trails.config.routes)
 *
 * Configure how routes map to views and controllers.
 *
 * @see http://trailsjs.io/doc/config/routes.js
 */

'use strict'

module.exports = [

  /**
   * Render the HelloWorld view
   */
  {
    method: 'GET',
    path: '/',
    handler: 'ViewController.helloWorld'
  },

  /**
   * Constrain the DefaultController.info handler to accept only GET requests.
   */
  {
    method: 'GET',
    path: '/api/v2/default/info',
    handler: 'DefaultController.info'
  },

  /**
   * Default authentication path.
   */
  {
    method: 'POST',
    path: '/api/v2/jsonwebtoken',
    handler: 'AuthController.authenticate'
  },

  {
    method: 'GET',
    path: '/api/v2/user/{id?}',
    handler: 'UserController.find'
  },

  {
    method: [ 'PUT', 'PATCH' ],
    path: '/api/v2/user/{id?}',
    handler: 'UserController.update'
  },

  {
    method: 'DELETE',
    path: '/api/v2/user/{id?}',
    handler: 'UserController.destroy'
  },

  {
    method: 'GET',
    path: '/api/v2/list/{id?}',
    handler: 'ListController.find'
  },

  {
    method: [ 'PUT', 'PATCH' ],
    path: '/api/v2/list/{id?}',
    handler: 'ListController.update'
  },

  {
    method: 'DELETE',
    path: '/api/v2/list/{id?}',
    handler: 'ListController.destroy'
  },

  {
    method: 'GET',
    path: '/api/v2/listuser/{id?}',
    handler: 'ListUserController.find'
  },

  {
    method: 'POST',
    path: '/api/v2/listuser',
    handler: 'ListUserController.create'
  }
]
