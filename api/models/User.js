'use strict';

const Model = require('trails/model');
const Schema = require('mongoose').Schema;
const Bcrypt = require('bcryptjs');
const Libphonenumber = require('google-libphonenumber');
const https = require('https');
const _ = require('lodash');
const listTypes = ['list', 'operation', 'bundle', 'disaster', 'organization', 'functional_role', 'office'];
const userPopulate1 = [
  {path: 'favoriteLists'},
  {path: 'verified_by', select: '_id name'},
  {path: 'subscriptions.service', select: '_id name'},
  {path: 'connections.user', select: '_id name'},
  {path: 'authorizedClients', select: '_id id name'}
];

/**
 * @module User
 * @description User
 */
module.exports = class User extends Model {

  static config () {
    return {
      schema: {
        timestamps: true,
        toObject: {
          virtuals: true
        },
        toJSON: {
          virtuals: true
        }
      },
      statics: {
        hashPassword: function (password) {
          return Bcrypt.hashSync(password, 11);
        },
        explodeHash: function (hashLink) {
          const key = new Buffer(hashLink, 'base64').toString('ascii');
          const parts = key.split('/');
          return {
            'email': parts[0],
            'timestamp': parts[1],
            'hash': new Buffer(parts[2], 'base64').toString('ascii')
          };
        },
        listAttributes: function () {
          return [
            'lists',
            'operations',
            'bundles',
            'disasters',
            'organization',
            'organizations',
            'functional_roles',
            'offices'
          ];
        }
      },
      methods: {
        sanitize: function (user) {
          this.sanitizeClients();
          this.sanitizeLists(user);
          if (this._id.toString() !== user._id.toString() && !user.is_admin) {
            if (this.emailsVisibility !== 'anyone') {
              if ((this.emailsVisibility === 'verified' && !user.verified) ||
                  (this.emailsVisibility === 'connections' && this.connectionsIndex(user._id) === -1)) {
                this.email = null;
                this.emails = [];
              }
            }

            if (this.phonesVisibility !== 'anyone') {
              if ((this.phonesVisibility === 'verified' && !user.verified) ||
                  (this.phonesVisibility === 'connections' && this.connectionsIndex(user._id) === -1)) {
                this.phone_number = null;
                this.phone_numbers = [];
              }
            }

            if (this.locationsVisibility !== 'anyone') {
              if ((this.locationsVisibility === 'verified' && !user.verified) ||
                  (this.locationsVisibility === 'connections' && this.connectionsIndex(user._id) === -1)) {
                this.location = null;
                this.locations = [];
              }
            }
          }
        },
        getAppUrl: function () {
          return process.env.APP_URL + '/users/' + this._id;
        },
        sanitizeLists: function (user) {
          if (this._id.toString() !== user._id.toString() && !user.is_admin && !user.isManager) {
            const that = this;
            listTypes.forEach(function (attr) {
              _.remove(that[attr + 's'], function (checkin) {
                return checkin.visibility === 'inlist' ||
                  checkin.visibility === 'me' ||
                  checkin.visibility === 'verified' && !user.verified;
              });
            });
          }
        },
        sanitizeClients: function () {
          if (this.authorizedClients && this.authorizedClients.length) {
            const sanitized = [];
            for (let i = 0, len = this.authorizedClients.length; i < len; i++) {
              if (this.authorizedClients[i].secret) {
                sanitized.push({
                  id: this.authorizedClients[i].id,
                  name: this.authorizedClients[i].name
                });
              }
              else {
                sanitized.push(this.authorizedClients[i]);
              }
            }
          }
        },
        validPassword: function (password)  {
          if (!this.password) {
            return false;
          }
          else {
            return Bcrypt.compareSync(password, this.password);
          }
        },

        generateHash: function (email) {
          const now = Date.now();
          const hash = new Buffer(Bcrypt.hashSync(this.password + now + this._id, 11)).toString('base64');
          return new Buffer(email + '/' + now + '/' + hash).toString('base64');
        },

        // Validate the hash of a confirmation link
        validHash: function (hashLink) {
          const key = new Buffer(hashLink, 'base64').toString('ascii');
          const parts = key.split('/');
          const email = parts[0];
          const timestamp = parts[1];
          const hash = new Buffer(parts[2], 'base64').toString('ascii');
          const now = Date.now();

          // Verify hash
          // verify timestamp is not too old (allow up to 7 days in milliseconds)
          if (timestamp < (now - 7 * 86400000) || timestamp > now) {
            return 'Expired confirmation link';
          }

          if (this.emailIndex(email) === -1) {
            return 'Wrong user or wrong email in the hash';
          }

          // verify hash
          if (!Bcrypt.compareSync(this.password + timestamp + this._id, hash)) {
            return 'This verification link has already been used';
          }
          return true;
        },

        emailIndex: function (email) {
          let index = -1;
          for (let i = 0, len = this.emails.length; i < len; i++) {
            if (this.emails[i].email === email) {
              index = i;
            }
          }
          return index;
        },

        connectionsIndex: function (userId) {
          let index = -1;
          if (this.connections && this.connections.length) {
            for (let i = 0, len = this.connections.length; i < len; i++) {
              if (this.connections[i].pending === false &&
                ((this.connections[i].user._id && this.connections[i].user._id.toString() === userId.toString()) ||
                (!this.connections[i].user._id && this.connections[i].user.toString() === userId.toString()))) {
                index = i;
              }
            }
          }
          return index;
        },

        hasAuthorizedClient: function (clientId) {
          let out = false;
          for (let i = 0, len = this.authorizedClients.length; i < len; i++) {
            if (this.authorizedClients[i].id === clientId) {
              out = true;
            }
          }
          return out;
        },

        subscriptionsIndex: function (serviceId) {
          const id = serviceId.toString();
          let index = -1;
          for (let i = 0; i < this.subscriptions.length; i++) {
            if ((this.subscriptions[i].service._id && this.subscriptions[i].service._id.toString() === id) ||
              this.subscriptions[i].service.toString() === id) {
              index = i;
            }
          }
          return index;
        },

        // Whether we should send a reminder to verify email to user
        // Reminder emails are sent out 2, 4, 7 and 30 days after registration
        shouldSendReminderVerify: function() {
          const created = new Date(this.createdAt),
            current = Date.now(),
            remindedVerify = new Date(this.remindedVerify);
          if (this.email_verified || this.is_orphan || this.is_ghost) {
            return false;
          }
          if (!this.remindedVerify && !this.timesRemindedVerify && current.valueOf() - created.valueOf() > 48 * 3600 * 1000) {
            return true;
          }
          if (this.remindedVerify && this.timesRemindedVerify === 1 && current.valueOf() - remindedVerify.valueOf() > 48 * 3600 * 1000) {
            return true;
          }
          if (this.remindedVerify && this.timesRemindedVerify === 2 && current.valueOf() - remindedVerify.valueOf() > 72 * 3600 * 1000) {
            return true;
          }
          if (this.remindedVerify && this.timesRemindedVerify === 3 && current.valueOf() - remindedVerify.valueOf() > 23 * 24 * 3600 * 1000) {
            return true;
          }
          return false;
        },

        // Whether we should send an update reminder (sent out after a user hasn't been updated for 6 months)
        shouldSendReminderUpdate: function () {
          const d = new Date();
          const revisedOffset = d.valueOf() - this.updatedAt.valueOf();
          if (revisedOffset < 183 * 24 * 3600 * 1000) { // if not revised during 6 months
            return false;
          }
          if (this.remindedUpdate) {
            const remindedOffset = d.valueOf() - this.remindedUpdate.valueOf();
            if (remindedOffset < 183 * 24 * 3600 * 1000) {
              return false;
            }
          }
          return true;
        },

        hasLocalPhoneNumber: function (iso2) {
          let found = false;
          const that = this;
          this.phone_numbers.forEach(function (item) {
            const phoneUtil = Libphonenumber.PhoneNumberUtil.getInstance();
            try {
              const phoneNumber = phoneUtil.parse(item.number);
              const regionCode = phoneUtil.getRegionCodeForNumber(phoneNumber);
              if (regionCode.toUpperCase() === iso2) {
                found = true;
              }
            }
            catch (err) {
              // Invalid phone number
              that.log.error(err);
            }
          });
          return found;
        },

        // Whether the contact is in country or not
        isInCountry: function (pcode, callback) {
          const hrinfoId = this.location.country.id.replace('hrinfo_loc_', '');
          const path = '/api/v1.0/locations/' + hrinfoId,
            that = this;
          https.get({
            host: 'www.humanitarianresponse.info',
            port: 443,
            path: path
          }, function (response) {
            let body = '';
            response.on('data', function (d) {
              body += d;
            });
            response.on('end', function() {
              let parsed = {};
              try {
                parsed = JSON.parse(body);
                if (parsed.data[0].pcode === pcode) {
                  return callback(null, true);
                }
                else {
                  return callback(null, false);
                }
              }
              catch (e) {
                that.log.info('Error parsing hrinfo API: ' + e);
                return callback(e);
              }
            });
          });
        },

        translateCheckin: function (checkin, language) {
          let name = '', nameEn = '', acronym = '', acronymEn = '';
          checkin.names.forEach(function (nameLn) {
            if (nameLn.language === language) {
              name = nameLn.text;
            }
            if (nameLn.language === 'en') {
              nameEn = nameLn.text;
            }
          });
          checkin.acronyms.forEach(function (acroLn) {
            if (acroLn.language === language) {
              acronym = acroLn.text;
            }
            if (acroLn.language === 'en') {
              acronymEn = acroLn.text;
            }
          });
          if (name !== '') {
            checkin.name = name;
          }
          else {
            if (nameEn !== '') {
              checkin.name = nameEn;
            }
          }
          if (acronym !== '') {
            checkin.acronym = acronym;
          }
          else {
            if (acronymEn !== '') {
              checkin.acronym = acronymEn;
            }
          }
        },

        translateListNames: function (language) {
          const that = this;
          listTypes.forEach(function (listType) {
            if (that[listType + 's'] && that[listType + 's'].length) {
              that[listType + 's'].forEach(function (checkin) {
                that.translateCheckin(checkin, language);
              });
            }
          });
          if (this.organization) {
            this.translateCheckin(this.organization, language);
          }
        },

        defaultPopulate: function () {
          return this
            .populate(userPopulate1)
            .execPopulate();
        },

        toJSON: function () {
          const user = this.toObject();
          delete user.password;
          listTypes.forEach(function (attr) {
            _.remove(user[attr + 's'], function (checkin) {
              return checkin.deleted;
            });
          });
          return user;
        }
      },
      onSchema(app, schema) {
        schema.virtual('sub').get(function () {
          return this._id;
        });
        schema.pre('save', function (next) {
          if (this.middle_name) {
            this.name = this.given_name + ' ' + this.middle_name + ' ' + this.family_name;
          }
          else {
            this.name = this.given_name + ' ' + this.family_name;
          }
          if (this.is_orphan || this.is_ghost) {
            this.appMetadata.hid.login = true;
          }
          if (!this.user_id) {
            this.user_id = this._id;
          }
          next ();
        });
        schema.post('findOneAndUpdate', function (user) {
          // Calling user.save to go through the presave hook and update user name
          user.save();
        });
        schema.post('findOne', function (result, next) {
          const that = this;
          if (!result) {
            return next();
          }
          result
            .populate(userPopulate1)
            .execPopulate()
            .then(user => {
              return next();
            })
            .catch(err => {
              that.log.error(err);
            }
          );
        });
      }
    };
  }

  static schema () {

    const visibilities = ['anyone', 'verified', 'connections'];

    const emailSchema = new Schema({
      type: {
        type: String,
        enum: ['Work', 'Personal']
      },
      email: {
        type: String,
        lowercase: true,
        trim: true,
        unique: true,
        sparse: true,
        match: /^([\w-\.\+]+@([\w-]+\.)+[\w-]{2,4})?$/
      },
      validated: {
        type: Boolean,
        default: false
      }
    }, { readonly: true });

    const phoneSchema = new Schema({
      type: {
        type: String,
        enum: ['Landline', 'Mobile', 'Fax', 'Satellite']
      },
      number: {
        type: String,
        validate: {
          validator: function (v) {
            if (v !== '') {
              try {
                const phoneUtil = Libphonenumber.PhoneNumberUtil.getInstance();
                const phone = phoneUtil.parse(v);
                return phoneUtil.isValidNumber(phone);
              }
              catch (e) {
                return false;
              }
            }
            else {
              return true;
            }
          },
          message: '{VALUE} is not a valid phone number !'
        }
      },
      validated: {
        type: Boolean,
        default: false
      }
    });

    const translationSchema = new Schema({
      language: {
        type: String,
        enum: ['en', 'fr', 'es']
      },
      text: {
        type: String
      }
    });

    const connectionSchema = new Schema({
      pending: {
        type: Boolean,
        default: true
      },
      user: {
        type: Schema.ObjectId,
        ref: 'User'
      },
      createdAt: {
        type: Date,
        default: Date.now
      }
    });

    const listUserSchema = new Schema({
      list: {
        type: Schema.ObjectId,
        ref: 'List'
      },
      name: { type: String},
      names: [translationSchema],
      acronym: { type: String},
      acronyms: [translationSchema],
      visibility: {
        type: String,
        enum: ['me', 'inlist', 'all', 'verified'],
      },
      orgTypeId: {
        type: Number
      },
      orgTypeLabel: {
        type: String,
        enum: [
          'Academic / Research',
          'Civilian',
          'Donor',
          'Embassy',
          'Government',
          'International Military Force',
          'International NGO',
          'International Organization',
          'Media',
          'Military',
          'National NGO',
          'Non state armed groups',
          'Other',
          'Private sector',
          'Red Cross / Red Crescent',
          'Religious',
          'United Nations',
          'Unknown'
        ]
      },
      checkoutDate: Date,
      pending: {
        type: Boolean,
        default: true
      },
      remindedCheckout: {
        type: Boolean,
        default: false
      },
      remindedCheckin: {
        type: Boolean,
        default: false
      },
      deleted: {
        type: Boolean,
        default: false
      },
      createdAt: {
        type: Date,
        default: Date.now
      }
    });

    const subscriptionSchema = new Schema({
      email: {
        type: String,
        lowercase: true,
        trim: true,
        match: /^([\w-\.\+]+@([\w-]+\.)+[\w-]{2,4})?$/,
        required: true
      },
      service: {
        type: Schema.ObjectId,
        ref: 'Service',
        required: true
      }
    });

    return {
      // Legacy user_id data, to be added during migration
      user_id: {
        type: String,
        readonly: true
      },
      // Legacy ID data, added during the migration
      legacyId: {
        type: String,
        readonly: true
      },
      given_name: {
        type: String,
        trim: true,
        required: [true, 'Given name is required']
      },
      middle_name: {
        type: String,
        trim: true
      },
      family_name: {
        type: String,
        trim: true,
        required: [true, 'Family name is required']
      },
      name: {
        type: String
      },
      email: {
        type: String,
        lowercase: true,
        trim: true,
        unique: true,
        sparse: true,
        match: /^([\w-\.\+]+@([\w-]+\.)+[\w-]{2,4})?$/
      },
      email_verified: {
        type: Boolean,
        default: false,
        readonly: true
      },
      // Last time the user was reminded to verify his account
      remindedVerify: {
        type: Date,
        readonly: true
      },
      // How many times the user was reminded to verify his account
      timesRemindedVerify: {
        type: Number,
        default: 0,
        readonly: true
      },
      // Last time the user was reminded to update his account details
      remindedUpdate: {
        type: Date,
        readonly: true
      },
      // TODO: find a way to set this as readonly
      emails: [emailSchema],
      emailsVisibility: {
        type: String,
        enum: visibilities,
        default: 'anyone'
      },
      password: {
        type: String
      },
      // Only admins can set this
      verified: {
        type: Boolean,
        default: false,
        managerOnly: true
      },
      verified_by: {
        type: Schema.ObjectId,
        ref: 'User',
        readonly: true
      },
      // Makes sure it's a valid URL
      picture: {
        type: String,
        match: /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/
      },
      notes: {
        type: String
      },
      // Validates an array of VoIP objects
      voips: {
        type: Array,
        validate: {
          validator: function (v) {
            if (v.length) {
              let out = true;
              const types = ['Skype', 'Google', 'Facebook', 'Yahoo', 'Twitter'];
              for (let i = 0, len = v.length; i < len; i++) {
                if (!v[i].username || !v[i].type || (v[i].type && types.indexOf(v[i].type) === -1)) {
                  out = false;
                }
              }
              return out;
            }
            else {
              return true;
            }
          },
          message: 'Invalid voip found'
        }
      },
      // Validates urls
      websites: {
        type: Array,
        validate: {
          validator: function (v) {
            if (v.length) {
              let out = true;
              const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/;
              for (let i = 0, len = v.length; i < len; i++) {
                if (!urlRegex.test(v[i].url)) {
                  out = false;
                }
              }
              return out;
            }
            else {
              return true;
            }
          },
          message: 'There is an invalid url'
        }
      },
      // TODO: validate timezone
      zoneinfo: {
        type: String
      },
      locale: {
        type: String,
        enum: ['en', 'fr', 'es', 'ar'],
        default: 'en'
      },
      // TODO :make sure it's a valid organization
      organization: listUserSchema,
      organizations: [listUserSchema],
      // Verify valid phone number with libphonenumber and reformat if needed
      phone_number: {
        type: String,
        validate: {
          validator: function (v) {
            if (v !== '') {
              try {
                const phoneUtil = Libphonenumber.PhoneNumberUtil.getInstance();
                const phone = phoneUtil.parse(v);
                return phoneUtil.isValidNumber(phone);
              }
              catch (e) {
                return false;
              }
            }
            else {
              return true;
            }
          },
          message: '{VALUE} is not a valid phone number !'
        }
      },
      phone_number_type: {
        type: String,
        enum: ['Mobile', 'Landline', 'Fax', 'Satellite'],
      },
      // TODO: find a way to set this as readonly
      phone_numbers: [phoneSchema],
      phonesVisibility: {
        type: String,
        enum: visibilities,
        default: 'anyone'
      },
      job_title: {
        type: String
      },
      job_titles: {
        type: Array
      },
      functional_roles: [listUserSchema],
      status: {
        type: String
      },
      // TODO: make sure this is a valid location
      location: {
        type: Schema.Types.Mixed
      },
      locations: {
        type: Array
      },
      locationsVisibility: {
        type: String,
        enum: visibilities,
        default: 'anyone'
      },
      // Only an admin can set this
      is_admin: {
        type: Boolean,
        default: false,
        adminOnly: true
      },
      isManager: {
        type: Boolean,
        default: false,
        adminOnly: true
      },
      is_orphan: {
        type: Boolean,
        default: false,
        readonly: true
      },
      is_ghost: {
        type: Boolean,
        default: false,
        readonly: true
      },
      expires: {
        type: Date,
        default: new Date() + 7 * 24 * 60 * 60 * 1000,
        readonly: true
      },
      lastLogin: {
        type: Date,
        readonly: true
      },
      createdBy: {
        type: Schema.ObjectId,
        ref: 'User',
        readonly: true
      },
      favoriteLists: [{
        type: Schema.ObjectId,
        ref: 'List'
      }],
      lists: [listUserSchema],
      operations: [listUserSchema],
      bundles: [listUserSchema],
      disasters: [listUserSchema],
      offices: [listUserSchema],
      authorizedClients: [{
        type: Schema.ObjectId,
        ref: 'Client'
      }],
      subscriptions: [subscriptionSchema],
      connections: [connectionSchema],
      appMetadata: {
        type: Schema.Types.Mixed
      },
      deleted: {
        type: Boolean,
        default: false
      }
    };
  }
};
