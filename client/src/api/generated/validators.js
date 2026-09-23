/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// node_modules/ajv/dist/runtime/ucs2length.js
var require_ucs2length = __commonJS({
  "node_modules/ajv/dist/runtime/ucs2length.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function ucs2length(str) {
      const len = str.length;
      let length = 0;
      let pos = 0;
      let value;
      while (pos < len) {
        length++;
        value = str.charCodeAt(pos++);
        if (value >= 55296 && value <= 56319 && pos < len) {
          value = str.charCodeAt(pos);
          if ((value & 64512) === 56320)
            pos++;
        }
      }
      return length;
    }
    exports.default = ucs2length;
    ucs2length.code = 'require("ajv/dist/runtime/ucs2length").default';
  }
});

// validators.js
var isAcceptInviteRequest = validate20;
var schema31 = { "$id": "urn:paracord:contract:AcceptInviteRequest", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "`POST /invites/{code}` accepts an optional JSON body.", "properties": { "verification_ack": { "type": ["boolean", "null"] }, "verification_answers": { "items": { "type": "string" }, "type": ["array", "null"] } }, "title": "AcceptInviteRequest", "type": "object" };
function validate20(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate20.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      if (data.verification_ack !== void 0) {
        let data0 = data.verification_ack;
        const _errs1 = errors;
        if (typeof data0 !== "boolean" && data0 !== null) {
          validate20.errors = [{ instancePath: instancePath + "/verification_ack", schemaPath: "#/properties/verification_ack/type", keyword: "type", params: { type: schema31.properties.verification_ack.type }, message: "must be boolean,null" }];
          return false;
        }
        var valid0 = _errs1 === errors;
      } else {
        var valid0 = true;
      }
      if (valid0) {
        if (data.verification_answers !== void 0) {
          let data1 = data.verification_answers;
          const _errs3 = errors;
          if (!Array.isArray(data1) && data1 !== null) {
            validate20.errors = [{ instancePath: instancePath + "/verification_answers", schemaPath: "#/properties/verification_answers/type", keyword: "type", params: { type: schema31.properties.verification_answers.type }, message: "must be array,null" }];
            return false;
          }
          if (errors === _errs3) {
            if (Array.isArray(data1)) {
              var valid1 = true;
              const len0 = data1.length;
              for (let i0 = 0; i0 < len0; i0++) {
                const _errs5 = errors;
                if (typeof data1[i0] !== "string") {
                  validate20.errors = [{ instancePath: instancePath + "/verification_answers/" + i0, schemaPath: "#/properties/verification_answers/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid1 = _errs5 === errors;
                if (!valid1) {
                  break;
                }
              }
            }
          }
          var valid0 = _errs3 === errors;
        } else {
          var valid0 = true;
        }
      }
    } else {
      validate20.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate20.errors = vErrors;
  return errors === 0;
}
validate20.evaluated = { "props": { "verification_ack": true, "verification_answers": true }, "dynamicProps": false, "dynamicItems": false };
var isChangeEmailRequest = validate21;
function validate21(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate21.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.current_password === void 0 && (missing0 = "current_password") || data.new_email === void 0 && (missing0 = "new_email")) {
        validate21.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.current_password !== void 0) {
          const _errs1 = errors;
          if (typeof data.current_password !== "string") {
            validate21.errors = [{ instancePath: instancePath + "/current_password", schemaPath: "#/properties/current_password/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.new_email !== void 0) {
            const _errs3 = errors;
            if (typeof data.new_email !== "string") {
              validate21.errors = [{ instancePath: instancePath + "/new_email", schemaPath: "#/properties/new_email/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
        }
      }
    } else {
      validate21.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate21.errors = vErrors;
  return errors === 0;
}
validate21.evaluated = { "props": { "current_password": true, "new_email": true }, "dynamicProps": false, "dynamicItems": false };
var isChangePasswordRequest = validate22;
function validate22(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate22.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.current_password === void 0 && (missing0 = "current_password") || data.new_password === void 0 && (missing0 = "new_password")) {
        validate22.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.current_password !== void 0) {
          const _errs1 = errors;
          if (typeof data.current_password !== "string") {
            validate22.errors = [{ instancePath: instancePath + "/current_password", schemaPath: "#/properties/current_password/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.new_password !== void 0) {
            const _errs3 = errors;
            if (typeof data.new_password !== "string") {
              validate22.errors = [{ instancePath: instancePath + "/new_password", schemaPath: "#/properties/new_password/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
        }
      }
    } else {
      validate22.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate22.errors = vErrors;
  return errors === 0;
}
validate22.evaluated = { "props": { "current_password": true, "new_password": true }, "dynamicProps": false, "dynamicItems": false };
var isCreateGuildRequest = validate23;
var schema34 = { "$id": "urn:paracord:contract:CreateGuildRequest", "$schema": "https://json-schema.org/draft/2020-12/schema", "properties": { "icon": { "type": ["string", "null"] }, "name": { "type": "string" } }, "required": ["name"], "title": "CreateGuildRequest", "type": "object" };
function validate23(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate23.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.name === void 0 && (missing0 = "name")) {
        validate23.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.icon !== void 0) {
          let data0 = data.icon;
          const _errs1 = errors;
          if (typeof data0 !== "string" && data0 !== null) {
            validate23.errors = [{ instancePath: instancePath + "/icon", schemaPath: "#/properties/icon/type", keyword: "type", params: { type: schema34.properties.icon.type }, message: "must be string,null" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.name !== void 0) {
            const _errs3 = errors;
            if (typeof data.name !== "string") {
              validate23.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
        }
      }
    } else {
      validate23.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate23.errors = vErrors;
  return errors === 0;
}
validate23.evaluated = { "props": { "icon": true, "name": true }, "dynamicProps": false, "dynamicItems": false };
var isCreateInviteRequest = validate24;
function validate24(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate24.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      if (data.max_age !== void 0) {
        let data0 = data.max_age;
        const _errs1 = errors;
        if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)) && isFinite(data0))) {
          validate24.errors = [{ instancePath: instancePath + "/max_age", schemaPath: "#/properties/max_age/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
          return false;
        }
        var valid0 = _errs1 === errors;
      } else {
        var valid0 = true;
      }
      if (valid0) {
        if (data.max_uses !== void 0) {
          let data1 = data.max_uses;
          const _errs3 = errors;
          if (!(typeof data1 == "number" && (!(data1 % 1) && !isNaN(data1)) && isFinite(data1))) {
            validate24.errors = [{ instancePath: instancePath + "/max_uses", schemaPath: "#/properties/max_uses/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
            return false;
          }
          var valid0 = _errs3 === errors;
        } else {
          var valid0 = true;
        }
      }
    } else {
      validate24.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate24.errors = vErrors;
  return errors === 0;
}
validate24.evaluated = { "props": { "max_age": true, "max_uses": true }, "dynamicProps": false, "dynamicItems": false };
var isCreateRelationshipRequest = validate25;
var schema36 = { "$id": "urn:paracord:contract:CreateRelationshipRequest", "$schema": "https://json-schema.org/draft/2020-12/schema", "properties": { "type": { "description": "Only 1 (friend request) and 2 (block) are accepted.", "format": "int32", "type": ["integer", "null"] }, "user_id": { "type": ["string", "null"] }, "username": { "type": ["string", "null"] } }, "title": "CreateRelationshipRequest", "type": "object" };
function validate25(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate25.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      if (data.type !== void 0) {
        let data0 = data.type;
        const _errs1 = errors;
        if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)) && isFinite(data0)) && data0 !== null) {
          validate25.errors = [{ instancePath: instancePath + "/type", schemaPath: "#/properties/type/type", keyword: "type", params: { type: schema36.properties.type.type }, message: "must be integer,null" }];
          return false;
        }
        var valid0 = _errs1 === errors;
      } else {
        var valid0 = true;
      }
      if (valid0) {
        if (data.user_id !== void 0) {
          let data1 = data.user_id;
          const _errs3 = errors;
          if (typeof data1 !== "string" && data1 !== null) {
            validate25.errors = [{ instancePath: instancePath + "/user_id", schemaPath: "#/properties/user_id/type", keyword: "type", params: { type: schema36.properties.user_id.type }, message: "must be string,null" }];
            return false;
          }
          var valid0 = _errs3 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.username !== void 0) {
            let data2 = data.username;
            const _errs5 = errors;
            if (typeof data2 !== "string" && data2 !== null) {
              validate25.errors = [{ instancePath: instancePath + "/username", schemaPath: "#/properties/username/type", keyword: "type", params: { type: schema36.properties.username.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs5 === errors;
          } else {
            var valid0 = true;
          }
        }
      }
    } else {
      validate25.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate25.errors = vErrors;
  return errors === 0;
}
validate25.evaluated = { "props": { "type": true, "user_id": true, "username": true }, "dynamicProps": false, "dynamicItems": false };
var isCurrentUser = validate26;
var schema37 = { "$defs": { "LinkedAccount": { "description": "A linked account published on a user's public profile.", "properties": { "label": { "type": "string" }, "url": { "type": "string" } }, "required": ["label", "url"], "type": "object" } }, "$id": "urn:paracord:contract:CurrentUser", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "`GET /users/@me`: the authenticated account, including credential metadata.", "properties": { "accent_color": { "description": "Profile accent as `0xRRGGBB`. Omitted when the member has not chosen one.\n\nNew in 3.2. Unlike the other nullable fields it may be absent rather\nthan null, so a 3.2 client can still read accounts from a 3.1 instance,\nwhich never sends it.", "format": "int32", "type": ["integer", "null"] }, "avatar_hash": { "type": ["string", "null"] }, "banner_hash": { "type": ["string", "null"] }, "bio": { "type": ["string", "null"] }, "bot": { "type": "boolean" }, "created_at": { "type": "string" }, "discriminator": { "format": "int32", "type": "integer" }, "display_name": { "type": ["string", "null"] }, "email": { "type": "string" }, "email_verified": { "type": "boolean" }, "flags": { "format": "int32", "type": "integer" }, "has_public_key": { "type": "boolean" }, "id": { "type": "string" }, "linked_accounts": { "items": { "$ref": "#/$defs/LinkedAccount" }, "type": "array" }, "pronouns": { "type": ["string", "null"] }, "public_key": { "description": "An attached Ed25519 key can authenticate this account on its own, so the\nowner must be able to see that one exists and which one it is.", "type": ["string", "null"] }, "system": { "type": "boolean" }, "username": { "type": "string" } }, "required": ["id", "username", "discriminator", "display_name", "avatar_hash", "banner_hash", "bio", "flags", "bot", "system", "created_at", "pronouns", "linked_accounts", "email", "email_verified", "public_key", "has_public_key"], "title": "CurrentUser", "type": "object" };
function validate26(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate26.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.id === void 0 && (missing0 = "id") || data.username === void 0 && (missing0 = "username") || data.discriminator === void 0 && (missing0 = "discriminator") || data.display_name === void 0 && (missing0 = "display_name") || data.avatar_hash === void 0 && (missing0 = "avatar_hash") || data.banner_hash === void 0 && (missing0 = "banner_hash") || data.bio === void 0 && (missing0 = "bio") || data.flags === void 0 && (missing0 = "flags") || data.bot === void 0 && (missing0 = "bot") || data.system === void 0 && (missing0 = "system") || data.created_at === void 0 && (missing0 = "created_at") || data.pronouns === void 0 && (missing0 = "pronouns") || data.linked_accounts === void 0 && (missing0 = "linked_accounts") || data.email === void 0 && (missing0 = "email") || data.email_verified === void 0 && (missing0 = "email_verified") || data.public_key === void 0 && (missing0 = "public_key") || data.has_public_key === void 0 && (missing0 = "has_public_key")) {
        validate26.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.accent_color !== void 0) {
          let data0 = data.accent_color;
          const _errs1 = errors;
          if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)) && isFinite(data0)) && data0 !== null) {
            validate26.errors = [{ instancePath: instancePath + "/accent_color", schemaPath: "#/properties/accent_color/type", keyword: "type", params: { type: schema37.properties.accent_color.type }, message: "must be integer,null" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.avatar_hash !== void 0) {
            let data1 = data.avatar_hash;
            const _errs3 = errors;
            if (typeof data1 !== "string" && data1 !== null) {
              validate26.errors = [{ instancePath: instancePath + "/avatar_hash", schemaPath: "#/properties/avatar_hash/type", keyword: "type", params: { type: schema37.properties.avatar_hash.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.banner_hash !== void 0) {
              let data2 = data.banner_hash;
              const _errs5 = errors;
              if (typeof data2 !== "string" && data2 !== null) {
                validate26.errors = [{ instancePath: instancePath + "/banner_hash", schemaPath: "#/properties/banner_hash/type", keyword: "type", params: { type: schema37.properties.banner_hash.type }, message: "must be string,null" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.bio !== void 0) {
                let data3 = data.bio;
                const _errs7 = errors;
                if (typeof data3 !== "string" && data3 !== null) {
                  validate26.errors = [{ instancePath: instancePath + "/bio", schemaPath: "#/properties/bio/type", keyword: "type", params: { type: schema37.properties.bio.type }, message: "must be string,null" }];
                  return false;
                }
                var valid0 = _errs7 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.bot !== void 0) {
                  const _errs9 = errors;
                  if (typeof data.bot !== "boolean") {
                    validate26.errors = [{ instancePath: instancePath + "/bot", schemaPath: "#/properties/bot/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                    return false;
                  }
                  var valid0 = _errs9 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.created_at !== void 0) {
                    const _errs11 = errors;
                    if (typeof data.created_at !== "string") {
                      validate26.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid0 = _errs11 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.discriminator !== void 0) {
                      let data6 = data.discriminator;
                      const _errs13 = errors;
                      if (!(typeof data6 == "number" && (!(data6 % 1) && !isNaN(data6)) && isFinite(data6))) {
                        validate26.errors = [{ instancePath: instancePath + "/discriminator", schemaPath: "#/properties/discriminator/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      var valid0 = _errs13 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.display_name !== void 0) {
                        let data7 = data.display_name;
                        const _errs15 = errors;
                        if (typeof data7 !== "string" && data7 !== null) {
                          validate26.errors = [{ instancePath: instancePath + "/display_name", schemaPath: "#/properties/display_name/type", keyword: "type", params: { type: schema37.properties.display_name.type }, message: "must be string,null" }];
                          return false;
                        }
                        var valid0 = _errs15 === errors;
                      } else {
                        var valid0 = true;
                      }
                      if (valid0) {
                        if (data.email !== void 0) {
                          const _errs17 = errors;
                          if (typeof data.email !== "string") {
                            validate26.errors = [{ instancePath: instancePath + "/email", schemaPath: "#/properties/email/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                            return false;
                          }
                          var valid0 = _errs17 === errors;
                        } else {
                          var valid0 = true;
                        }
                        if (valid0) {
                          if (data.email_verified !== void 0) {
                            const _errs19 = errors;
                            if (typeof data.email_verified !== "boolean") {
                              validate26.errors = [{ instancePath: instancePath + "/email_verified", schemaPath: "#/properties/email_verified/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                              return false;
                            }
                            var valid0 = _errs19 === errors;
                          } else {
                            var valid0 = true;
                          }
                          if (valid0) {
                            if (data.flags !== void 0) {
                              let data10 = data.flags;
                              const _errs21 = errors;
                              if (!(typeof data10 == "number" && (!(data10 % 1) && !isNaN(data10)) && isFinite(data10))) {
                                validate26.errors = [{ instancePath: instancePath + "/flags", schemaPath: "#/properties/flags/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                                return false;
                              }
                              var valid0 = _errs21 === errors;
                            } else {
                              var valid0 = true;
                            }
                            if (valid0) {
                              if (data.has_public_key !== void 0) {
                                const _errs23 = errors;
                                if (typeof data.has_public_key !== "boolean") {
                                  validate26.errors = [{ instancePath: instancePath + "/has_public_key", schemaPath: "#/properties/has_public_key/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                                  return false;
                                }
                                var valid0 = _errs23 === errors;
                              } else {
                                var valid0 = true;
                              }
                              if (valid0) {
                                if (data.id !== void 0) {
                                  const _errs25 = errors;
                                  if (typeof data.id !== "string") {
                                    validate26.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                    return false;
                                  }
                                  var valid0 = _errs25 === errors;
                                } else {
                                  var valid0 = true;
                                }
                                if (valid0) {
                                  if (data.linked_accounts !== void 0) {
                                    let data13 = data.linked_accounts;
                                    const _errs27 = errors;
                                    if (errors === _errs27) {
                                      if (Array.isArray(data13)) {
                                        var valid1 = true;
                                        const len0 = data13.length;
                                        for (let i0 = 0; i0 < len0; i0++) {
                                          let data14 = data13[i0];
                                          const _errs29 = errors;
                                          const _errs30 = errors;
                                          if (errors === _errs30) {
                                            if (data14 && typeof data14 == "object" && !Array.isArray(data14)) {
                                              let missing1;
                                              if (data14.label === void 0 && (missing1 = "label") || data14.url === void 0 && (missing1 = "url")) {
                                                validate26.errors = [{ instancePath: instancePath + "/linked_accounts/" + i0, schemaPath: "#/$defs/LinkedAccount/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                                                return false;
                                              } else {
                                                if (data14.label !== void 0) {
                                                  const _errs32 = errors;
                                                  if (typeof data14.label !== "string") {
                                                    validate26.errors = [{ instancePath: instancePath + "/linked_accounts/" + i0 + "/label", schemaPath: "#/$defs/LinkedAccount/properties/label/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                                    return false;
                                                  }
                                                  var valid3 = _errs32 === errors;
                                                } else {
                                                  var valid3 = true;
                                                }
                                                if (valid3) {
                                                  if (data14.url !== void 0) {
                                                    const _errs34 = errors;
                                                    if (typeof data14.url !== "string") {
                                                      validate26.errors = [{ instancePath: instancePath + "/linked_accounts/" + i0 + "/url", schemaPath: "#/$defs/LinkedAccount/properties/url/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                                      return false;
                                                    }
                                                    var valid3 = _errs34 === errors;
                                                  } else {
                                                    var valid3 = true;
                                                  }
                                                }
                                              }
                                            } else {
                                              validate26.errors = [{ instancePath: instancePath + "/linked_accounts/" + i0, schemaPath: "#/$defs/LinkedAccount/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                                              return false;
                                            }
                                          }
                                          var valid1 = _errs29 === errors;
                                          if (!valid1) {
                                            break;
                                          }
                                        }
                                      } else {
                                        validate26.errors = [{ instancePath: instancePath + "/linked_accounts", schemaPath: "#/properties/linked_accounts/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
                                        return false;
                                      }
                                    }
                                    var valid0 = _errs27 === errors;
                                  } else {
                                    var valid0 = true;
                                  }
                                  if (valid0) {
                                    if (data.pronouns !== void 0) {
                                      let data17 = data.pronouns;
                                      const _errs36 = errors;
                                      if (typeof data17 !== "string" && data17 !== null) {
                                        validate26.errors = [{ instancePath: instancePath + "/pronouns", schemaPath: "#/properties/pronouns/type", keyword: "type", params: { type: schema37.properties.pronouns.type }, message: "must be string,null" }];
                                        return false;
                                      }
                                      var valid0 = _errs36 === errors;
                                    } else {
                                      var valid0 = true;
                                    }
                                    if (valid0) {
                                      if (data.public_key !== void 0) {
                                        let data18 = data.public_key;
                                        const _errs38 = errors;
                                        if (typeof data18 !== "string" && data18 !== null) {
                                          validate26.errors = [{ instancePath: instancePath + "/public_key", schemaPath: "#/properties/public_key/type", keyword: "type", params: { type: schema37.properties.public_key.type }, message: "must be string,null" }];
                                          return false;
                                        }
                                        var valid0 = _errs38 === errors;
                                      } else {
                                        var valid0 = true;
                                      }
                                      if (valid0) {
                                        if (data.system !== void 0) {
                                          const _errs40 = errors;
                                          if (typeof data.system !== "boolean") {
                                            validate26.errors = [{ instancePath: instancePath + "/system", schemaPath: "#/properties/system/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                                            return false;
                                          }
                                          var valid0 = _errs40 === errors;
                                        } else {
                                          var valid0 = true;
                                        }
                                        if (valid0) {
                                          if (data.username !== void 0) {
                                            const _errs42 = errors;
                                            if (typeof data.username !== "string") {
                                              validate26.errors = [{ instancePath: instancePath + "/username", schemaPath: "#/properties/username/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                              return false;
                                            }
                                            var valid0 = _errs42 === errors;
                                          } else {
                                            var valid0 = true;
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate26.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate26.errors = vErrors;
  return errors === 0;
}
validate26.evaluated = { "props": { "accent_color": true, "avatar_hash": true, "banner_hash": true, "bio": true, "bot": true, "created_at": true, "discriminator": true, "display_name": true, "email": true, "email_verified": true, "flags": true, "has_public_key": true, "id": true, "linked_accounts": true, "pronouns": true, "public_key": true, "system": true, "username": true }, "dynamicProps": false, "dynamicItems": false };
var isGuildDetail = validate27;
var schema39 = { "$defs": { "GuildBotConfig": { "additionalProperties": true, "properties": { "enabled": { "type": ["boolean", "null"] } }, "type": "object" }, "GuildVisibility": { "enum": ["private", "public", "roles"], "type": "string" }, "HubSettings": { "additionalProperties": true, "properties": { "description": { "type": ["string", "null"] }, "pinned_channels": { "items": { "type": "string" }, "type": ["array", "null"] }, "welcome_text": { "type": ["string", "null"] } }, "type": "object" } }, "$id": "urn:paracord:contract:GuildDetail", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "Full settings returned by the space detail and mutation endpoints.", "properties": { "allowed_roles": { "items": { "type": "string" }, "type": "array" }, "banner_hash": { "description": "`/api/v1/guilds/{id}/banner?v=\u2026` once a banner is uploaded, otherwise null.\nThe version changes with every upload.", "type": ["string", "null"] }, "bot_settings": { "additionalProperties": { "$ref": "#/$defs/GuildBotConfig" }, "type": ["object", "null"] }, "created_at": { "type": "string" }, "description": { "type": ["string", "null"] }, "discovery_tags": { "items": { "type": "string" }, "type": "array" }, "feature_flags": { "description": "The persisted feature bitset; it is not an array of feature names.", "format": "int32", "maximum": 2147483647, "minimum": -2147483648, "type": "integer" }, "hub_settings": { "anyOf": [{ "$ref": "#/$defs/HubSettings" }, { "type": "null" }] }, "icon_hash": { "type": ["string", "null"] }, "id": { "type": "string" }, "member_count": { "format": "uint32", "maximum": 4294967295, "minimum": 0, "type": "integer" }, "name": { "type": "string" }, "owner_id": { "type": "string" }, "system_channel_id": { "type": ["string", "null"] }, "vanity_url_code": { "type": ["string", "null"] }, "visibility": { "$ref": "#/$defs/GuildVisibility" } }, "required": ["id", "name", "description", "icon_hash", "banner_hash", "owner_id", "member_count", "created_at", "visibility", "allowed_roles", "discovery_tags", "hub_settings", "bot_settings", "system_channel_id", "vanity_url_code", "feature_flags"], "title": "GuildDetail", "type": "object" };
var schema40 = { "additionalProperties": true, "properties": { "enabled": { "type": ["boolean", "null"] } }, "type": "object" };
var schema41 = { "additionalProperties": true, "properties": { "description": { "type": ["string", "null"] }, "pinned_channels": { "items": { "type": "string" }, "type": ["array", "null"] }, "welcome_text": { "type": ["string", "null"] } }, "type": "object" };
var schema42 = { "enum": ["private", "public", "roles"], "type": "string" };
function validate27(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate27.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.id === void 0 && (missing0 = "id") || data.name === void 0 && (missing0 = "name") || data.description === void 0 && (missing0 = "description") || data.icon_hash === void 0 && (missing0 = "icon_hash") || data.banner_hash === void 0 && (missing0 = "banner_hash") || data.owner_id === void 0 && (missing0 = "owner_id") || data.member_count === void 0 && (missing0 = "member_count") || data.created_at === void 0 && (missing0 = "created_at") || data.visibility === void 0 && (missing0 = "visibility") || data.allowed_roles === void 0 && (missing0 = "allowed_roles") || data.discovery_tags === void 0 && (missing0 = "discovery_tags") || data.hub_settings === void 0 && (missing0 = "hub_settings") || data.bot_settings === void 0 && (missing0 = "bot_settings") || data.system_channel_id === void 0 && (missing0 = "system_channel_id") || data.vanity_url_code === void 0 && (missing0 = "vanity_url_code") || data.feature_flags === void 0 && (missing0 = "feature_flags")) {
        validate27.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.allowed_roles !== void 0) {
          let data0 = data.allowed_roles;
          const _errs1 = errors;
          if (errors === _errs1) {
            if (Array.isArray(data0)) {
              var valid1 = true;
              const len0 = data0.length;
              for (let i0 = 0; i0 < len0; i0++) {
                const _errs3 = errors;
                if (typeof data0[i0] !== "string") {
                  validate27.errors = [{ instancePath: instancePath + "/allowed_roles/" + i0, schemaPath: "#/properties/allowed_roles/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid1 = _errs3 === errors;
                if (!valid1) {
                  break;
                }
              }
            } else {
              validate27.errors = [{ instancePath: instancePath + "/allowed_roles", schemaPath: "#/properties/allowed_roles/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
              return false;
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.banner_hash !== void 0) {
            let data2 = data.banner_hash;
            const _errs5 = errors;
            if (typeof data2 !== "string" && data2 !== null) {
              validate27.errors = [{ instancePath: instancePath + "/banner_hash", schemaPath: "#/properties/banner_hash/type", keyword: "type", params: { type: schema39.properties.banner_hash.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs5 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.bot_settings !== void 0) {
              let data3 = data.bot_settings;
              const _errs7 = errors;
              if (!(data3 && typeof data3 == "object" && !Array.isArray(data3)) && data3 !== null) {
                validate27.errors = [{ instancePath: instancePath + "/bot_settings", schemaPath: "#/properties/bot_settings/type", keyword: "type", params: { type: schema39.properties.bot_settings.type }, message: "must be object,null" }];
                return false;
              }
              if (errors === _errs7) {
                if (data3 && typeof data3 == "object" && !Array.isArray(data3)) {
                  for (const key0 in data3) {
                    let data4 = data3[key0];
                    const _errs10 = errors;
                    const _errs11 = errors;
                    if (errors === _errs11) {
                      if (data4 && typeof data4 == "object" && !Array.isArray(data4)) {
                        if (data4.enabled !== void 0) {
                          let data5 = data4.enabled;
                          if (typeof data5 !== "boolean" && data5 !== null) {
                            validate27.errors = [{ instancePath: instancePath + "/bot_settings/" + key0.replace(/~/g, "~0").replace(/\//g, "~1") + "/enabled", schemaPath: "#/$defs/GuildBotConfig/properties/enabled/type", keyword: "type", params: { type: schema40.properties.enabled.type }, message: "must be boolean,null" }];
                            return false;
                          }
                        }
                      } else {
                        validate27.errors = [{ instancePath: instancePath + "/bot_settings/" + key0.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/$defs/GuildBotConfig/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                        return false;
                      }
                    }
                    var valid2 = _errs10 === errors;
                    if (!valid2) {
                      break;
                    }
                  }
                }
              }
              var valid0 = _errs7 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.created_at !== void 0) {
                const _errs16 = errors;
                if (typeof data.created_at !== "string") {
                  validate27.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid0 = _errs16 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.description !== void 0) {
                  let data7 = data.description;
                  const _errs18 = errors;
                  if (typeof data7 !== "string" && data7 !== null) {
                    validate27.errors = [{ instancePath: instancePath + "/description", schemaPath: "#/properties/description/type", keyword: "type", params: { type: schema39.properties.description.type }, message: "must be string,null" }];
                    return false;
                  }
                  var valid0 = _errs18 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.discovery_tags !== void 0) {
                    let data8 = data.discovery_tags;
                    const _errs20 = errors;
                    if (errors === _errs20) {
                      if (Array.isArray(data8)) {
                        var valid5 = true;
                        const len1 = data8.length;
                        for (let i1 = 0; i1 < len1; i1++) {
                          const _errs22 = errors;
                          if (typeof data8[i1] !== "string") {
                            validate27.errors = [{ instancePath: instancePath + "/discovery_tags/" + i1, schemaPath: "#/properties/discovery_tags/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                            return false;
                          }
                          var valid5 = _errs22 === errors;
                          if (!valid5) {
                            break;
                          }
                        }
                      } else {
                        validate27.errors = [{ instancePath: instancePath + "/discovery_tags", schemaPath: "#/properties/discovery_tags/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
                        return false;
                      }
                    }
                    var valid0 = _errs20 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.feature_flags !== void 0) {
                      let data10 = data.feature_flags;
                      const _errs24 = errors;
                      if (!(typeof data10 == "number" && (!(data10 % 1) && !isNaN(data10)) && isFinite(data10))) {
                        validate27.errors = [{ instancePath: instancePath + "/feature_flags", schemaPath: "#/properties/feature_flags/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      if (errors === _errs24) {
                        if (typeof data10 == "number" && isFinite(data10)) {
                          if (data10 > 2147483647 || isNaN(data10)) {
                            validate27.errors = [{ instancePath: instancePath + "/feature_flags", schemaPath: "#/properties/feature_flags/maximum", keyword: "maximum", params: { comparison: "<=", limit: 2147483647 }, message: "must be <= 2147483647" }];
                            return false;
                          } else {
                            if (data10 < -2147483648 || isNaN(data10)) {
                              validate27.errors = [{ instancePath: instancePath + "/feature_flags", schemaPath: "#/properties/feature_flags/minimum", keyword: "minimum", params: { comparison: ">=", limit: -2147483648 }, message: "must be >= -2147483648" }];
                              return false;
                            }
                          }
                        }
                      }
                      var valid0 = _errs24 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.hub_settings !== void 0) {
                        let data11 = data.hub_settings;
                        const _errs26 = errors;
                        const _errs27 = errors;
                        let valid6 = false;
                        const _errs28 = errors;
                        const _errs29 = errors;
                        if (errors === _errs29) {
                          if (data11 && typeof data11 == "object" && !Array.isArray(data11)) {
                            if (data11.description !== void 0) {
                              let data12 = data11.description;
                              const _errs32 = errors;
                              if (typeof data12 !== "string" && data12 !== null) {
                                const err0 = { instancePath: instancePath + "/hub_settings/description", schemaPath: "#/$defs/HubSettings/properties/description/type", keyword: "type", params: { type: schema41.properties.description.type }, message: "must be string,null" };
                                if (vErrors === null) {
                                  vErrors = [err0];
                                } else {
                                  vErrors.push(err0);
                                }
                                errors++;
                              }
                              var valid8 = _errs32 === errors;
                            } else {
                              var valid8 = true;
                            }
                            if (valid8) {
                              if (data11.pinned_channels !== void 0) {
                                let data13 = data11.pinned_channels;
                                const _errs34 = errors;
                                if (!Array.isArray(data13) && data13 !== null) {
                                  const err1 = { instancePath: instancePath + "/hub_settings/pinned_channels", schemaPath: "#/$defs/HubSettings/properties/pinned_channels/type", keyword: "type", params: { type: schema41.properties.pinned_channels.type }, message: "must be array,null" };
                                  if (vErrors === null) {
                                    vErrors = [err1];
                                  } else {
                                    vErrors.push(err1);
                                  }
                                  errors++;
                                }
                                if (errors === _errs34) {
                                  if (Array.isArray(data13)) {
                                    var valid9 = true;
                                    const len2 = data13.length;
                                    for (let i2 = 0; i2 < len2; i2++) {
                                      const _errs36 = errors;
                                      if (typeof data13[i2] !== "string") {
                                        const err2 = { instancePath: instancePath + "/hub_settings/pinned_channels/" + i2, schemaPath: "#/$defs/HubSettings/properties/pinned_channels/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                        if (vErrors === null) {
                                          vErrors = [err2];
                                        } else {
                                          vErrors.push(err2);
                                        }
                                        errors++;
                                      }
                                      var valid9 = _errs36 === errors;
                                      if (!valid9) {
                                        break;
                                      }
                                    }
                                  }
                                }
                                var valid8 = _errs34 === errors;
                              } else {
                                var valid8 = true;
                              }
                              if (valid8) {
                                if (data11.welcome_text !== void 0) {
                                  let data15 = data11.welcome_text;
                                  const _errs38 = errors;
                                  if (typeof data15 !== "string" && data15 !== null) {
                                    const err3 = { instancePath: instancePath + "/hub_settings/welcome_text", schemaPath: "#/$defs/HubSettings/properties/welcome_text/type", keyword: "type", params: { type: schema41.properties.welcome_text.type }, message: "must be string,null" };
                                    if (vErrors === null) {
                                      vErrors = [err3];
                                    } else {
                                      vErrors.push(err3);
                                    }
                                    errors++;
                                  }
                                  var valid8 = _errs38 === errors;
                                } else {
                                  var valid8 = true;
                                }
                              }
                            }
                          } else {
                            const err4 = { instancePath: instancePath + "/hub_settings", schemaPath: "#/$defs/HubSettings/type", keyword: "type", params: { type: "object" }, message: "must be object" };
                            if (vErrors === null) {
                              vErrors = [err4];
                            } else {
                              vErrors.push(err4);
                            }
                            errors++;
                          }
                        }
                        var _valid0 = _errs28 === errors;
                        valid6 = valid6 || _valid0;
                        const _errs40 = errors;
                        if (data11 !== null) {
                          const err5 = { instancePath: instancePath + "/hub_settings", schemaPath: "#/properties/hub_settings/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                          if (vErrors === null) {
                            vErrors = [err5];
                          } else {
                            vErrors.push(err5);
                          }
                          errors++;
                        }
                        var _valid0 = _errs40 === errors;
                        valid6 = valid6 || _valid0;
                        if (!valid6) {
                          const err6 = { instancePath: instancePath + "/hub_settings", schemaPath: "#/properties/hub_settings/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                          if (vErrors === null) {
                            vErrors = [err6];
                          } else {
                            vErrors.push(err6);
                          }
                          errors++;
                          validate27.errors = vErrors;
                          return false;
                        } else {
                          errors = _errs27;
                          if (vErrors !== null) {
                            if (_errs27) {
                              vErrors.length = _errs27;
                            } else {
                              vErrors = null;
                            }
                          }
                        }
                        var valid0 = _errs26 === errors;
                      } else {
                        var valid0 = true;
                      }
                      if (valid0) {
                        if (data.icon_hash !== void 0) {
                          let data16 = data.icon_hash;
                          const _errs42 = errors;
                          if (typeof data16 !== "string" && data16 !== null) {
                            validate27.errors = [{ instancePath: instancePath + "/icon_hash", schemaPath: "#/properties/icon_hash/type", keyword: "type", params: { type: schema39.properties.icon_hash.type }, message: "must be string,null" }];
                            return false;
                          }
                          var valid0 = _errs42 === errors;
                        } else {
                          var valid0 = true;
                        }
                        if (valid0) {
                          if (data.id !== void 0) {
                            const _errs44 = errors;
                            if (typeof data.id !== "string") {
                              validate27.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                              return false;
                            }
                            var valid0 = _errs44 === errors;
                          } else {
                            var valid0 = true;
                          }
                          if (valid0) {
                            if (data.member_count !== void 0) {
                              let data18 = data.member_count;
                              const _errs46 = errors;
                              if (!(typeof data18 == "number" && (!(data18 % 1) && !isNaN(data18)) && isFinite(data18))) {
                                validate27.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                                return false;
                              }
                              if (errors === _errs46) {
                                if (typeof data18 == "number" && isFinite(data18)) {
                                  if (data18 > 4294967295 || isNaN(data18)) {
                                    validate27.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" }];
                                    return false;
                                  } else {
                                    if (data18 < 0 || isNaN(data18)) {
                                      validate27.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                      return false;
                                    }
                                  }
                                }
                              }
                              var valid0 = _errs46 === errors;
                            } else {
                              var valid0 = true;
                            }
                            if (valid0) {
                              if (data.name !== void 0) {
                                const _errs48 = errors;
                                if (typeof data.name !== "string") {
                                  validate27.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                  return false;
                                }
                                var valid0 = _errs48 === errors;
                              } else {
                                var valid0 = true;
                              }
                              if (valid0) {
                                if (data.owner_id !== void 0) {
                                  const _errs50 = errors;
                                  if (typeof data.owner_id !== "string") {
                                    validate27.errors = [{ instancePath: instancePath + "/owner_id", schemaPath: "#/properties/owner_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                    return false;
                                  }
                                  var valid0 = _errs50 === errors;
                                } else {
                                  var valid0 = true;
                                }
                                if (valid0) {
                                  if (data.system_channel_id !== void 0) {
                                    let data21 = data.system_channel_id;
                                    const _errs52 = errors;
                                    if (typeof data21 !== "string" && data21 !== null) {
                                      validate27.errors = [{ instancePath: instancePath + "/system_channel_id", schemaPath: "#/properties/system_channel_id/type", keyword: "type", params: { type: schema39.properties.system_channel_id.type }, message: "must be string,null" }];
                                      return false;
                                    }
                                    var valid0 = _errs52 === errors;
                                  } else {
                                    var valid0 = true;
                                  }
                                  if (valid0) {
                                    if (data.vanity_url_code !== void 0) {
                                      let data22 = data.vanity_url_code;
                                      const _errs54 = errors;
                                      if (typeof data22 !== "string" && data22 !== null) {
                                        validate27.errors = [{ instancePath: instancePath + "/vanity_url_code", schemaPath: "#/properties/vanity_url_code/type", keyword: "type", params: { type: schema39.properties.vanity_url_code.type }, message: "must be string,null" }];
                                        return false;
                                      }
                                      var valid0 = _errs54 === errors;
                                    } else {
                                      var valid0 = true;
                                    }
                                    if (valid0) {
                                      if (data.visibility !== void 0) {
                                        let data23 = data.visibility;
                                        const _errs56 = errors;
                                        if (typeof data23 !== "string") {
                                          validate27.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/$defs/GuildVisibility/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                          return false;
                                        }
                                        if (!(data23 === "private" || data23 === "public" || data23 === "roles")) {
                                          validate27.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/$defs/GuildVisibility/enum", keyword: "enum", params: { allowedValues: schema42.enum }, message: "must be equal to one of the allowed values" }];
                                          return false;
                                        }
                                        var valid0 = _errs56 === errors;
                                      } else {
                                        var valid0 = true;
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate27.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate27.errors = vErrors;
  return errors === 0;
}
validate27.evaluated = { "props": { "allowed_roles": true, "banner_hash": true, "bot_settings": true, "created_at": true, "description": true, "discovery_tags": true, "feature_flags": true, "hub_settings": true, "icon_hash": true, "id": true, "member_count": true, "name": true, "owner_id": true, "system_channel_id": true, "vanity_url_code": true, "visibility": true }, "dynamicProps": false, "dynamicItems": false };
var isGuildEmoji = validate28;
var schema43 = { "$id": "urn:paracord:contract:GuildEmoji", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "A custom guild emoji. `creator_id` is null for emoji whose creator record\nis gone; the field is always present.", "properties": { "animated": { "type": "boolean" }, "created_at": { "type": "string" }, "creator_id": { "type": ["string", "null"] }, "guild_id": { "type": "string" }, "id": { "type": "string" }, "name": { "type": "string" } }, "required": ["id", "guild_id", "name", "animated", "creator_id", "created_at"], "title": "GuildEmoji", "type": "object" };
function validate28(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate28.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.id === void 0 && (missing0 = "id") || data.guild_id === void 0 && (missing0 = "guild_id") || data.name === void 0 && (missing0 = "name") || data.animated === void 0 && (missing0 = "animated") || data.creator_id === void 0 && (missing0 = "creator_id") || data.created_at === void 0 && (missing0 = "created_at")) {
        validate28.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.animated !== void 0) {
          const _errs1 = errors;
          if (typeof data.animated !== "boolean") {
            validate28.errors = [{ instancePath: instancePath + "/animated", schemaPath: "#/properties/animated/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.created_at !== void 0) {
            const _errs3 = errors;
            if (typeof data.created_at !== "string") {
              validate28.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.creator_id !== void 0) {
              let data2 = data.creator_id;
              const _errs5 = errors;
              if (typeof data2 !== "string" && data2 !== null) {
                validate28.errors = [{ instancePath: instancePath + "/creator_id", schemaPath: "#/properties/creator_id/type", keyword: "type", params: { type: schema43.properties.creator_id.type }, message: "must be string,null" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.guild_id !== void 0) {
                const _errs7 = errors;
                if (typeof data.guild_id !== "string") {
                  validate28.errors = [{ instancePath: instancePath + "/guild_id", schemaPath: "#/properties/guild_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid0 = _errs7 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.id !== void 0) {
                  const _errs9 = errors;
                  if (typeof data.id !== "string") {
                    validate28.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                  var valid0 = _errs9 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.name !== void 0) {
                    const _errs11 = errors;
                    if (typeof data.name !== "string") {
                      validate28.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid0 = _errs11 === errors;
                  } else {
                    var valid0 = true;
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate28.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate28.errors = vErrors;
  return errors === 0;
}
validate28.evaluated = { "props": { "animated": true, "created_at": true, "creator_id": true, "guild_id": true, "id": true, "name": true }, "dynamicProps": false, "dynamicItems": false };
var isGuildEmojiList = validate29;
var schema45 = { "description": "A custom guild emoji. `creator_id` is null for emoji whose creator record\nis gone; the field is always present.", "properties": { "animated": { "type": "boolean" }, "created_at": { "type": "string" }, "creator_id": { "type": ["string", "null"] }, "guild_id": { "type": "string" }, "id": { "type": "string" }, "name": { "type": "string" } }, "required": ["id", "guild_id", "name", "animated", "creator_id", "created_at"], "type": "object" };
function validate29(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate29.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (Array.isArray(data)) {
      var valid0 = true;
      const len0 = data.length;
      for (let i0 = 0; i0 < len0; i0++) {
        let data0 = data[i0];
        const _errs1 = errors;
        const _errs2 = errors;
        if (errors === _errs2) {
          if (data0 && typeof data0 == "object" && !Array.isArray(data0)) {
            let missing0;
            if (data0.id === void 0 && (missing0 = "id") || data0.guild_id === void 0 && (missing0 = "guild_id") || data0.name === void 0 && (missing0 = "name") || data0.animated === void 0 && (missing0 = "animated") || data0.creator_id === void 0 && (missing0 = "creator_id") || data0.created_at === void 0 && (missing0 = "created_at")) {
              validate29.errors = [{ instancePath: instancePath + "/" + i0, schemaPath: "#/$defs/GuildEmoji/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
              return false;
            } else {
              if (data0.animated !== void 0) {
                const _errs4 = errors;
                if (typeof data0.animated !== "boolean") {
                  validate29.errors = [{ instancePath: instancePath + "/" + i0 + "/animated", schemaPath: "#/$defs/GuildEmoji/properties/animated/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                  return false;
                }
                var valid2 = _errs4 === errors;
              } else {
                var valid2 = true;
              }
              if (valid2) {
                if (data0.created_at !== void 0) {
                  const _errs6 = errors;
                  if (typeof data0.created_at !== "string") {
                    validate29.errors = [{ instancePath: instancePath + "/" + i0 + "/created_at", schemaPath: "#/$defs/GuildEmoji/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                  var valid2 = _errs6 === errors;
                } else {
                  var valid2 = true;
                }
                if (valid2) {
                  if (data0.creator_id !== void 0) {
                    let data3 = data0.creator_id;
                    const _errs8 = errors;
                    if (typeof data3 !== "string" && data3 !== null) {
                      validate29.errors = [{ instancePath: instancePath + "/" + i0 + "/creator_id", schemaPath: "#/$defs/GuildEmoji/properties/creator_id/type", keyword: "type", params: { type: schema45.properties.creator_id.type }, message: "must be string,null" }];
                      return false;
                    }
                    var valid2 = _errs8 === errors;
                  } else {
                    var valid2 = true;
                  }
                  if (valid2) {
                    if (data0.guild_id !== void 0) {
                      const _errs10 = errors;
                      if (typeof data0.guild_id !== "string") {
                        validate29.errors = [{ instancePath: instancePath + "/" + i0 + "/guild_id", schemaPath: "#/$defs/GuildEmoji/properties/guild_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                        return false;
                      }
                      var valid2 = _errs10 === errors;
                    } else {
                      var valid2 = true;
                    }
                    if (valid2) {
                      if (data0.id !== void 0) {
                        const _errs12 = errors;
                        if (typeof data0.id !== "string") {
                          validate29.errors = [{ instancePath: instancePath + "/" + i0 + "/id", schemaPath: "#/$defs/GuildEmoji/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                          return false;
                        }
                        var valid2 = _errs12 === errors;
                      } else {
                        var valid2 = true;
                      }
                      if (valid2) {
                        if (data0.name !== void 0) {
                          const _errs14 = errors;
                          if (typeof data0.name !== "string") {
                            validate29.errors = [{ instancePath: instancePath + "/" + i0 + "/name", schemaPath: "#/$defs/GuildEmoji/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                            return false;
                          }
                          var valid2 = _errs14 === errors;
                        } else {
                          var valid2 = true;
                        }
                      }
                    }
                  }
                }
              }
            }
          } else {
            validate29.errors = [{ instancePath: instancePath + "/" + i0, schemaPath: "#/$defs/GuildEmoji/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
            return false;
          }
        }
        var valid0 = _errs1 === errors;
        if (!valid0) {
          break;
        }
      }
    } else {
      validate29.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
      return false;
    }
  }
  validate29.errors = vErrors;
  return errors === 0;
}
validate29.evaluated = { "items": true, "dynamicProps": false, "dynamicItems": false };
var isGuildInvite = validate30;
var schema46 = { "$id": "urn:paracord:contract:GuildInvite", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "A guild invite as returned by create and guild-scoped list endpoints.\nNullable fields are present in responses, including when their value is null.\n`max_uses`/`max_age` of 0 mean unlimited/never expire.", "properties": { "channel_id": { "type": "string" }, "code": { "type": "string" }, "created_at": { "type": "string" }, "guild_id": { "type": "string" }, "inviter_id": { "type": ["string", "null"] }, "max_age": { "format": "int32", "type": ["integer", "null"] }, "max_uses": { "format": "int32", "type": ["integer", "null"] }, "uses": { "format": "int32", "type": "integer" } }, "required": ["code", "guild_id", "channel_id", "inviter_id", "max_uses", "uses", "max_age", "created_at"], "title": "GuildInvite", "type": "object" };
function validate30(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate30.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.code === void 0 && (missing0 = "code") || data.guild_id === void 0 && (missing0 = "guild_id") || data.channel_id === void 0 && (missing0 = "channel_id") || data.inviter_id === void 0 && (missing0 = "inviter_id") || data.max_uses === void 0 && (missing0 = "max_uses") || data.uses === void 0 && (missing0 = "uses") || data.max_age === void 0 && (missing0 = "max_age") || data.created_at === void 0 && (missing0 = "created_at")) {
        validate30.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.channel_id !== void 0) {
          const _errs1 = errors;
          if (typeof data.channel_id !== "string") {
            validate30.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.code !== void 0) {
            const _errs3 = errors;
            if (typeof data.code !== "string") {
              validate30.errors = [{ instancePath: instancePath + "/code", schemaPath: "#/properties/code/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.created_at !== void 0) {
              const _errs5 = errors;
              if (typeof data.created_at !== "string") {
                validate30.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.guild_id !== void 0) {
                const _errs7 = errors;
                if (typeof data.guild_id !== "string") {
                  validate30.errors = [{ instancePath: instancePath + "/guild_id", schemaPath: "#/properties/guild_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid0 = _errs7 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.inviter_id !== void 0) {
                  let data4 = data.inviter_id;
                  const _errs9 = errors;
                  if (typeof data4 !== "string" && data4 !== null) {
                    validate30.errors = [{ instancePath: instancePath + "/inviter_id", schemaPath: "#/properties/inviter_id/type", keyword: "type", params: { type: schema46.properties.inviter_id.type }, message: "must be string,null" }];
                    return false;
                  }
                  var valid0 = _errs9 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.max_age !== void 0) {
                    let data5 = data.max_age;
                    const _errs11 = errors;
                    if (!(typeof data5 == "number" && (!(data5 % 1) && !isNaN(data5)) && isFinite(data5)) && data5 !== null) {
                      validate30.errors = [{ instancePath: instancePath + "/max_age", schemaPath: "#/properties/max_age/type", keyword: "type", params: { type: schema46.properties.max_age.type }, message: "must be integer,null" }];
                      return false;
                    }
                    var valid0 = _errs11 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.max_uses !== void 0) {
                      let data6 = data.max_uses;
                      const _errs13 = errors;
                      if (!(typeof data6 == "number" && (!(data6 % 1) && !isNaN(data6)) && isFinite(data6)) && data6 !== null) {
                        validate30.errors = [{ instancePath: instancePath + "/max_uses", schemaPath: "#/properties/max_uses/type", keyword: "type", params: { type: schema46.properties.max_uses.type }, message: "must be integer,null" }];
                        return false;
                      }
                      var valid0 = _errs13 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.uses !== void 0) {
                        let data7 = data.uses;
                        const _errs15 = errors;
                        if (!(typeof data7 == "number" && (!(data7 % 1) && !isNaN(data7)) && isFinite(data7))) {
                          validate30.errors = [{ instancePath: instancePath + "/uses", schemaPath: "#/properties/uses/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                          return false;
                        }
                        var valid0 = _errs15 === errors;
                      } else {
                        var valid0 = true;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate30.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate30.errors = vErrors;
  return errors === 0;
}
validate30.evaluated = { "props": { "channel_id": true, "code": true, "created_at": true, "guild_id": true, "inviter_id": true, "max_age": true, "max_uses": true, "uses": true }, "dynamicProps": false, "dynamicItems": false };
var isGuildInviteList = validate31;
var schema48 = { "description": "A guild invite as returned by create and guild-scoped list endpoints.\nNullable fields are present in responses, including when their value is null.\n`max_uses`/`max_age` of 0 mean unlimited/never expire.", "properties": { "channel_id": { "type": "string" }, "code": { "type": "string" }, "created_at": { "type": "string" }, "guild_id": { "type": "string" }, "inviter_id": { "type": ["string", "null"] }, "max_age": { "format": "int32", "type": ["integer", "null"] }, "max_uses": { "format": "int32", "type": ["integer", "null"] }, "uses": { "format": "int32", "type": "integer" } }, "required": ["code", "guild_id", "channel_id", "inviter_id", "max_uses", "uses", "max_age", "created_at"], "type": "object" };
function validate31(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate31.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (Array.isArray(data)) {
      var valid0 = true;
      const len0 = data.length;
      for (let i0 = 0; i0 < len0; i0++) {
        let data0 = data[i0];
        const _errs1 = errors;
        const _errs2 = errors;
        if (errors === _errs2) {
          if (data0 && typeof data0 == "object" && !Array.isArray(data0)) {
            let missing0;
            if (data0.code === void 0 && (missing0 = "code") || data0.guild_id === void 0 && (missing0 = "guild_id") || data0.channel_id === void 0 && (missing0 = "channel_id") || data0.inviter_id === void 0 && (missing0 = "inviter_id") || data0.max_uses === void 0 && (missing0 = "max_uses") || data0.uses === void 0 && (missing0 = "uses") || data0.max_age === void 0 && (missing0 = "max_age") || data0.created_at === void 0 && (missing0 = "created_at")) {
              validate31.errors = [{ instancePath: instancePath + "/" + i0, schemaPath: "#/$defs/GuildInvite/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
              return false;
            } else {
              if (data0.channel_id !== void 0) {
                const _errs4 = errors;
                if (typeof data0.channel_id !== "string") {
                  validate31.errors = [{ instancePath: instancePath + "/" + i0 + "/channel_id", schemaPath: "#/$defs/GuildInvite/properties/channel_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid2 = _errs4 === errors;
              } else {
                var valid2 = true;
              }
              if (valid2) {
                if (data0.code !== void 0) {
                  const _errs6 = errors;
                  if (typeof data0.code !== "string") {
                    validate31.errors = [{ instancePath: instancePath + "/" + i0 + "/code", schemaPath: "#/$defs/GuildInvite/properties/code/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                  var valid2 = _errs6 === errors;
                } else {
                  var valid2 = true;
                }
                if (valid2) {
                  if (data0.created_at !== void 0) {
                    const _errs8 = errors;
                    if (typeof data0.created_at !== "string") {
                      validate31.errors = [{ instancePath: instancePath + "/" + i0 + "/created_at", schemaPath: "#/$defs/GuildInvite/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid2 = _errs8 === errors;
                  } else {
                    var valid2 = true;
                  }
                  if (valid2) {
                    if (data0.guild_id !== void 0) {
                      const _errs10 = errors;
                      if (typeof data0.guild_id !== "string") {
                        validate31.errors = [{ instancePath: instancePath + "/" + i0 + "/guild_id", schemaPath: "#/$defs/GuildInvite/properties/guild_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                        return false;
                      }
                      var valid2 = _errs10 === errors;
                    } else {
                      var valid2 = true;
                    }
                    if (valid2) {
                      if (data0.inviter_id !== void 0) {
                        let data5 = data0.inviter_id;
                        const _errs12 = errors;
                        if (typeof data5 !== "string" && data5 !== null) {
                          validate31.errors = [{ instancePath: instancePath + "/" + i0 + "/inviter_id", schemaPath: "#/$defs/GuildInvite/properties/inviter_id/type", keyword: "type", params: { type: schema48.properties.inviter_id.type }, message: "must be string,null" }];
                          return false;
                        }
                        var valid2 = _errs12 === errors;
                      } else {
                        var valid2 = true;
                      }
                      if (valid2) {
                        if (data0.max_age !== void 0) {
                          let data6 = data0.max_age;
                          const _errs14 = errors;
                          if (!(typeof data6 == "number" && (!(data6 % 1) && !isNaN(data6)) && isFinite(data6)) && data6 !== null) {
                            validate31.errors = [{ instancePath: instancePath + "/" + i0 + "/max_age", schemaPath: "#/$defs/GuildInvite/properties/max_age/type", keyword: "type", params: { type: schema48.properties.max_age.type }, message: "must be integer,null" }];
                            return false;
                          }
                          var valid2 = _errs14 === errors;
                        } else {
                          var valid2 = true;
                        }
                        if (valid2) {
                          if (data0.max_uses !== void 0) {
                            let data7 = data0.max_uses;
                            const _errs16 = errors;
                            if (!(typeof data7 == "number" && (!(data7 % 1) && !isNaN(data7)) && isFinite(data7)) && data7 !== null) {
                              validate31.errors = [{ instancePath: instancePath + "/" + i0 + "/max_uses", schemaPath: "#/$defs/GuildInvite/properties/max_uses/type", keyword: "type", params: { type: schema48.properties.max_uses.type }, message: "must be integer,null" }];
                              return false;
                            }
                            var valid2 = _errs16 === errors;
                          } else {
                            var valid2 = true;
                          }
                          if (valid2) {
                            if (data0.uses !== void 0) {
                              let data8 = data0.uses;
                              const _errs18 = errors;
                              if (!(typeof data8 == "number" && (!(data8 % 1) && !isNaN(data8)) && isFinite(data8))) {
                                validate31.errors = [{ instancePath: instancePath + "/" + i0 + "/uses", schemaPath: "#/$defs/GuildInvite/properties/uses/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                                return false;
                              }
                              var valid2 = _errs18 === errors;
                            } else {
                              var valid2 = true;
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          } else {
            validate31.errors = [{ instancePath: instancePath + "/" + i0, schemaPath: "#/$defs/GuildInvite/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
            return false;
          }
        }
        var valid0 = _errs1 === errors;
        if (!valid0) {
          break;
        }
      }
    } else {
      validate31.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
      return false;
    }
  }
  validate31.errors = vErrors;
  return errors === 0;
}
validate31.evaluated = { "items": true, "dynamicProps": false, "dynamicItems": false };
var isGuildSummary = validate32;
var schema49 = { "$defs": { "GuildBotConfig": { "additionalProperties": true, "properties": { "enabled": { "type": ["boolean", "null"] } }, "type": "object" }, "GuildVisibility": { "enum": ["private", "public", "roles"], "type": "string" }, "HubSettings": { "additionalProperties": true, "properties": { "description": { "type": ["string", "null"] }, "pinned_channels": { "items": { "type": "string" }, "type": ["array", "null"] }, "welcome_text": { "type": ["string", "null"] } }, "type": "object" } }, "$id": "urn:paracord:contract:GuildSummary", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "Space metadata used by the authenticated space list and navigation.\nNullable fields are present in responses, including when their value is null.", "properties": { "allowed_roles": { "items": { "type": "string" }, "type": "array" }, "banner_hash": { "description": "`/api/v1/guilds/{id}/banner?v=\u2026` once a banner is uploaded, otherwise null.\nThe version changes with every upload.", "type": ["string", "null"] }, "bot_settings": { "additionalProperties": { "$ref": "#/$defs/GuildBotConfig" }, "type": ["object", "null"] }, "created_at": { "type": "string" }, "description": { "type": ["string", "null"] }, "discovery_tags": { "items": { "type": "string" }, "type": "array" }, "hub_settings": { "anyOf": [{ "$ref": "#/$defs/HubSettings" }, { "type": "null" }] }, "icon_hash": { "type": ["string", "null"] }, "id": { "type": "string" }, "member_count": { "format": "uint32", "maximum": 4294967295, "minimum": 0, "type": "integer" }, "name": { "type": "string" }, "owner_id": { "type": "string" }, "visibility": { "$ref": "#/$defs/GuildVisibility" } }, "required": ["id", "name", "description", "icon_hash", "banner_hash", "owner_id", "member_count", "created_at", "visibility", "allowed_roles", "discovery_tags", "hub_settings", "bot_settings"], "title": "GuildSummary", "type": "object" };
var schema50 = { "additionalProperties": true, "properties": { "enabled": { "type": ["boolean", "null"] } }, "type": "object" };
var schema51 = { "additionalProperties": true, "properties": { "description": { "type": ["string", "null"] }, "pinned_channels": { "items": { "type": "string" }, "type": ["array", "null"] }, "welcome_text": { "type": ["string", "null"] } }, "type": "object" };
var schema52 = { "enum": ["private", "public", "roles"], "type": "string" };
function validate32(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate32.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.id === void 0 && (missing0 = "id") || data.name === void 0 && (missing0 = "name") || data.description === void 0 && (missing0 = "description") || data.icon_hash === void 0 && (missing0 = "icon_hash") || data.banner_hash === void 0 && (missing0 = "banner_hash") || data.owner_id === void 0 && (missing0 = "owner_id") || data.member_count === void 0 && (missing0 = "member_count") || data.created_at === void 0 && (missing0 = "created_at") || data.visibility === void 0 && (missing0 = "visibility") || data.allowed_roles === void 0 && (missing0 = "allowed_roles") || data.discovery_tags === void 0 && (missing0 = "discovery_tags") || data.hub_settings === void 0 && (missing0 = "hub_settings") || data.bot_settings === void 0 && (missing0 = "bot_settings")) {
        validate32.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.allowed_roles !== void 0) {
          let data0 = data.allowed_roles;
          const _errs1 = errors;
          if (errors === _errs1) {
            if (Array.isArray(data0)) {
              var valid1 = true;
              const len0 = data0.length;
              for (let i0 = 0; i0 < len0; i0++) {
                const _errs3 = errors;
                if (typeof data0[i0] !== "string") {
                  validate32.errors = [{ instancePath: instancePath + "/allowed_roles/" + i0, schemaPath: "#/properties/allowed_roles/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid1 = _errs3 === errors;
                if (!valid1) {
                  break;
                }
              }
            } else {
              validate32.errors = [{ instancePath: instancePath + "/allowed_roles", schemaPath: "#/properties/allowed_roles/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
              return false;
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.banner_hash !== void 0) {
            let data2 = data.banner_hash;
            const _errs5 = errors;
            if (typeof data2 !== "string" && data2 !== null) {
              validate32.errors = [{ instancePath: instancePath + "/banner_hash", schemaPath: "#/properties/banner_hash/type", keyword: "type", params: { type: schema49.properties.banner_hash.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs5 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.bot_settings !== void 0) {
              let data3 = data.bot_settings;
              const _errs7 = errors;
              if (!(data3 && typeof data3 == "object" && !Array.isArray(data3)) && data3 !== null) {
                validate32.errors = [{ instancePath: instancePath + "/bot_settings", schemaPath: "#/properties/bot_settings/type", keyword: "type", params: { type: schema49.properties.bot_settings.type }, message: "must be object,null" }];
                return false;
              }
              if (errors === _errs7) {
                if (data3 && typeof data3 == "object" && !Array.isArray(data3)) {
                  for (const key0 in data3) {
                    let data4 = data3[key0];
                    const _errs10 = errors;
                    const _errs11 = errors;
                    if (errors === _errs11) {
                      if (data4 && typeof data4 == "object" && !Array.isArray(data4)) {
                        if (data4.enabled !== void 0) {
                          let data5 = data4.enabled;
                          if (typeof data5 !== "boolean" && data5 !== null) {
                            validate32.errors = [{ instancePath: instancePath + "/bot_settings/" + key0.replace(/~/g, "~0").replace(/\//g, "~1") + "/enabled", schemaPath: "#/$defs/GuildBotConfig/properties/enabled/type", keyword: "type", params: { type: schema50.properties.enabled.type }, message: "must be boolean,null" }];
                            return false;
                          }
                        }
                      } else {
                        validate32.errors = [{ instancePath: instancePath + "/bot_settings/" + key0.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/$defs/GuildBotConfig/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                        return false;
                      }
                    }
                    var valid2 = _errs10 === errors;
                    if (!valid2) {
                      break;
                    }
                  }
                }
              }
              var valid0 = _errs7 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.created_at !== void 0) {
                const _errs16 = errors;
                if (typeof data.created_at !== "string") {
                  validate32.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid0 = _errs16 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.description !== void 0) {
                  let data7 = data.description;
                  const _errs18 = errors;
                  if (typeof data7 !== "string" && data7 !== null) {
                    validate32.errors = [{ instancePath: instancePath + "/description", schemaPath: "#/properties/description/type", keyword: "type", params: { type: schema49.properties.description.type }, message: "must be string,null" }];
                    return false;
                  }
                  var valid0 = _errs18 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.discovery_tags !== void 0) {
                    let data8 = data.discovery_tags;
                    const _errs20 = errors;
                    if (errors === _errs20) {
                      if (Array.isArray(data8)) {
                        var valid5 = true;
                        const len1 = data8.length;
                        for (let i1 = 0; i1 < len1; i1++) {
                          const _errs22 = errors;
                          if (typeof data8[i1] !== "string") {
                            validate32.errors = [{ instancePath: instancePath + "/discovery_tags/" + i1, schemaPath: "#/properties/discovery_tags/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                            return false;
                          }
                          var valid5 = _errs22 === errors;
                          if (!valid5) {
                            break;
                          }
                        }
                      } else {
                        validate32.errors = [{ instancePath: instancePath + "/discovery_tags", schemaPath: "#/properties/discovery_tags/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
                        return false;
                      }
                    }
                    var valid0 = _errs20 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.hub_settings !== void 0) {
                      let data10 = data.hub_settings;
                      const _errs24 = errors;
                      const _errs25 = errors;
                      let valid6 = false;
                      const _errs26 = errors;
                      const _errs27 = errors;
                      if (errors === _errs27) {
                        if (data10 && typeof data10 == "object" && !Array.isArray(data10)) {
                          if (data10.description !== void 0) {
                            let data11 = data10.description;
                            const _errs30 = errors;
                            if (typeof data11 !== "string" && data11 !== null) {
                              const err0 = { instancePath: instancePath + "/hub_settings/description", schemaPath: "#/$defs/HubSettings/properties/description/type", keyword: "type", params: { type: schema51.properties.description.type }, message: "must be string,null" };
                              if (vErrors === null) {
                                vErrors = [err0];
                              } else {
                                vErrors.push(err0);
                              }
                              errors++;
                            }
                            var valid8 = _errs30 === errors;
                          } else {
                            var valid8 = true;
                          }
                          if (valid8) {
                            if (data10.pinned_channels !== void 0) {
                              let data12 = data10.pinned_channels;
                              const _errs32 = errors;
                              if (!Array.isArray(data12) && data12 !== null) {
                                const err1 = { instancePath: instancePath + "/hub_settings/pinned_channels", schemaPath: "#/$defs/HubSettings/properties/pinned_channels/type", keyword: "type", params: { type: schema51.properties.pinned_channels.type }, message: "must be array,null" };
                                if (vErrors === null) {
                                  vErrors = [err1];
                                } else {
                                  vErrors.push(err1);
                                }
                                errors++;
                              }
                              if (errors === _errs32) {
                                if (Array.isArray(data12)) {
                                  var valid9 = true;
                                  const len2 = data12.length;
                                  for (let i2 = 0; i2 < len2; i2++) {
                                    const _errs34 = errors;
                                    if (typeof data12[i2] !== "string") {
                                      const err2 = { instancePath: instancePath + "/hub_settings/pinned_channels/" + i2, schemaPath: "#/$defs/HubSettings/properties/pinned_channels/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                      if (vErrors === null) {
                                        vErrors = [err2];
                                      } else {
                                        vErrors.push(err2);
                                      }
                                      errors++;
                                    }
                                    var valid9 = _errs34 === errors;
                                    if (!valid9) {
                                      break;
                                    }
                                  }
                                }
                              }
                              var valid8 = _errs32 === errors;
                            } else {
                              var valid8 = true;
                            }
                            if (valid8) {
                              if (data10.welcome_text !== void 0) {
                                let data14 = data10.welcome_text;
                                const _errs36 = errors;
                                if (typeof data14 !== "string" && data14 !== null) {
                                  const err3 = { instancePath: instancePath + "/hub_settings/welcome_text", schemaPath: "#/$defs/HubSettings/properties/welcome_text/type", keyword: "type", params: { type: schema51.properties.welcome_text.type }, message: "must be string,null" };
                                  if (vErrors === null) {
                                    vErrors = [err3];
                                  } else {
                                    vErrors.push(err3);
                                  }
                                  errors++;
                                }
                                var valid8 = _errs36 === errors;
                              } else {
                                var valid8 = true;
                              }
                            }
                          }
                        } else {
                          const err4 = { instancePath: instancePath + "/hub_settings", schemaPath: "#/$defs/HubSettings/type", keyword: "type", params: { type: "object" }, message: "must be object" };
                          if (vErrors === null) {
                            vErrors = [err4];
                          } else {
                            vErrors.push(err4);
                          }
                          errors++;
                        }
                      }
                      var _valid0 = _errs26 === errors;
                      valid6 = valid6 || _valid0;
                      const _errs38 = errors;
                      if (data10 !== null) {
                        const err5 = { instancePath: instancePath + "/hub_settings", schemaPath: "#/properties/hub_settings/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                        if (vErrors === null) {
                          vErrors = [err5];
                        } else {
                          vErrors.push(err5);
                        }
                        errors++;
                      }
                      var _valid0 = _errs38 === errors;
                      valid6 = valid6 || _valid0;
                      if (!valid6) {
                        const err6 = { instancePath: instancePath + "/hub_settings", schemaPath: "#/properties/hub_settings/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                        if (vErrors === null) {
                          vErrors = [err6];
                        } else {
                          vErrors.push(err6);
                        }
                        errors++;
                        validate32.errors = vErrors;
                        return false;
                      } else {
                        errors = _errs25;
                        if (vErrors !== null) {
                          if (_errs25) {
                            vErrors.length = _errs25;
                          } else {
                            vErrors = null;
                          }
                        }
                      }
                      var valid0 = _errs24 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.icon_hash !== void 0) {
                        let data15 = data.icon_hash;
                        const _errs40 = errors;
                        if (typeof data15 !== "string" && data15 !== null) {
                          validate32.errors = [{ instancePath: instancePath + "/icon_hash", schemaPath: "#/properties/icon_hash/type", keyword: "type", params: { type: schema49.properties.icon_hash.type }, message: "must be string,null" }];
                          return false;
                        }
                        var valid0 = _errs40 === errors;
                      } else {
                        var valid0 = true;
                      }
                      if (valid0) {
                        if (data.id !== void 0) {
                          const _errs42 = errors;
                          if (typeof data.id !== "string") {
                            validate32.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                            return false;
                          }
                          var valid0 = _errs42 === errors;
                        } else {
                          var valid0 = true;
                        }
                        if (valid0) {
                          if (data.member_count !== void 0) {
                            let data17 = data.member_count;
                            const _errs44 = errors;
                            if (!(typeof data17 == "number" && (!(data17 % 1) && !isNaN(data17)) && isFinite(data17))) {
                              validate32.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                              return false;
                            }
                            if (errors === _errs44) {
                              if (typeof data17 == "number" && isFinite(data17)) {
                                if (data17 > 4294967295 || isNaN(data17)) {
                                  validate32.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" }];
                                  return false;
                                } else {
                                  if (data17 < 0 || isNaN(data17)) {
                                    validate32.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                    return false;
                                  }
                                }
                              }
                            }
                            var valid0 = _errs44 === errors;
                          } else {
                            var valid0 = true;
                          }
                          if (valid0) {
                            if (data.name !== void 0) {
                              const _errs46 = errors;
                              if (typeof data.name !== "string") {
                                validate32.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                return false;
                              }
                              var valid0 = _errs46 === errors;
                            } else {
                              var valid0 = true;
                            }
                            if (valid0) {
                              if (data.owner_id !== void 0) {
                                const _errs48 = errors;
                                if (typeof data.owner_id !== "string") {
                                  validate32.errors = [{ instancePath: instancePath + "/owner_id", schemaPath: "#/properties/owner_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                  return false;
                                }
                                var valid0 = _errs48 === errors;
                              } else {
                                var valid0 = true;
                              }
                              if (valid0) {
                                if (data.visibility !== void 0) {
                                  let data20 = data.visibility;
                                  const _errs50 = errors;
                                  if (typeof data20 !== "string") {
                                    validate32.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/$defs/GuildVisibility/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                    return false;
                                  }
                                  if (!(data20 === "private" || data20 === "public" || data20 === "roles")) {
                                    validate32.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/$defs/GuildVisibility/enum", keyword: "enum", params: { allowedValues: schema52.enum }, message: "must be equal to one of the allowed values" }];
                                    return false;
                                  }
                                  var valid0 = _errs50 === errors;
                                } else {
                                  var valid0 = true;
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate32.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate32.errors = vErrors;
  return errors === 0;
}
validate32.evaluated = { "props": { "allowed_roles": true, "banner_hash": true, "bot_settings": true, "created_at": true, "description": true, "discovery_tags": true, "hub_settings": true, "icon_hash": true, "id": true, "member_count": true, "name": true, "owner_id": true, "visibility": true }, "dynamicProps": false, "dynamicItems": false };
var isGuildSummaryList = validate33;
var schema54 = { "description": "Space metadata used by the authenticated space list and navigation.\nNullable fields are present in responses, including when their value is null.", "properties": { "allowed_roles": { "items": { "type": "string" }, "type": "array" }, "banner_hash": { "description": "`/api/v1/guilds/{id}/banner?v=\u2026` once a banner is uploaded, otherwise null.\nThe version changes with every upload.", "type": ["string", "null"] }, "bot_settings": { "additionalProperties": { "$ref": "#/$defs/GuildBotConfig" }, "type": ["object", "null"] }, "created_at": { "type": "string" }, "description": { "type": ["string", "null"] }, "discovery_tags": { "items": { "type": "string" }, "type": "array" }, "hub_settings": { "anyOf": [{ "$ref": "#/$defs/HubSettings" }, { "type": "null" }] }, "icon_hash": { "type": ["string", "null"] }, "id": { "type": "string" }, "member_count": { "format": "uint32", "maximum": 4294967295, "minimum": 0, "type": "integer" }, "name": { "type": "string" }, "owner_id": { "type": "string" }, "visibility": { "$ref": "#/$defs/GuildVisibility" } }, "required": ["id", "name", "description", "icon_hash", "banner_hash", "owner_id", "member_count", "created_at", "visibility", "allowed_roles", "discovery_tags", "hub_settings", "bot_settings"], "type": "object" };
var schema55 = { "additionalProperties": true, "properties": { "enabled": { "type": ["boolean", "null"] } }, "type": "object" };
var schema56 = { "additionalProperties": true, "properties": { "description": { "type": ["string", "null"] }, "pinned_channels": { "items": { "type": "string" }, "type": ["array", "null"] }, "welcome_text": { "type": ["string", "null"] } }, "type": "object" };
var schema57 = { "enum": ["private", "public", "roles"], "type": "string" };
function validate34(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate34.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.id === void 0 && (missing0 = "id") || data.name === void 0 && (missing0 = "name") || data.description === void 0 && (missing0 = "description") || data.icon_hash === void 0 && (missing0 = "icon_hash") || data.banner_hash === void 0 && (missing0 = "banner_hash") || data.owner_id === void 0 && (missing0 = "owner_id") || data.member_count === void 0 && (missing0 = "member_count") || data.created_at === void 0 && (missing0 = "created_at") || data.visibility === void 0 && (missing0 = "visibility") || data.allowed_roles === void 0 && (missing0 = "allowed_roles") || data.discovery_tags === void 0 && (missing0 = "discovery_tags") || data.hub_settings === void 0 && (missing0 = "hub_settings") || data.bot_settings === void 0 && (missing0 = "bot_settings")) {
        validate34.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.allowed_roles !== void 0) {
          let data0 = data.allowed_roles;
          const _errs1 = errors;
          if (errors === _errs1) {
            if (Array.isArray(data0)) {
              var valid1 = true;
              const len0 = data0.length;
              for (let i0 = 0; i0 < len0; i0++) {
                const _errs3 = errors;
                if (typeof data0[i0] !== "string") {
                  validate34.errors = [{ instancePath: instancePath + "/allowed_roles/" + i0, schemaPath: "#/properties/allowed_roles/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid1 = _errs3 === errors;
                if (!valid1) {
                  break;
                }
              }
            } else {
              validate34.errors = [{ instancePath: instancePath + "/allowed_roles", schemaPath: "#/properties/allowed_roles/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
              return false;
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.banner_hash !== void 0) {
            let data2 = data.banner_hash;
            const _errs5 = errors;
            if (typeof data2 !== "string" && data2 !== null) {
              validate34.errors = [{ instancePath: instancePath + "/banner_hash", schemaPath: "#/properties/banner_hash/type", keyword: "type", params: { type: schema54.properties.banner_hash.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs5 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.bot_settings !== void 0) {
              let data3 = data.bot_settings;
              const _errs7 = errors;
              if (!(data3 && typeof data3 == "object" && !Array.isArray(data3)) && data3 !== null) {
                validate34.errors = [{ instancePath: instancePath + "/bot_settings", schemaPath: "#/properties/bot_settings/type", keyword: "type", params: { type: schema54.properties.bot_settings.type }, message: "must be object,null" }];
                return false;
              }
              if (errors === _errs7) {
                if (data3 && typeof data3 == "object" && !Array.isArray(data3)) {
                  for (const key0 in data3) {
                    let data4 = data3[key0];
                    const _errs10 = errors;
                    const _errs11 = errors;
                    if (errors === _errs11) {
                      if (data4 && typeof data4 == "object" && !Array.isArray(data4)) {
                        if (data4.enabled !== void 0) {
                          let data5 = data4.enabled;
                          if (typeof data5 !== "boolean" && data5 !== null) {
                            validate34.errors = [{ instancePath: instancePath + "/bot_settings/" + key0.replace(/~/g, "~0").replace(/\//g, "~1") + "/enabled", schemaPath: "#/$defs/GuildBotConfig/properties/enabled/type", keyword: "type", params: { type: schema55.properties.enabled.type }, message: "must be boolean,null" }];
                            return false;
                          }
                        }
                      } else {
                        validate34.errors = [{ instancePath: instancePath + "/bot_settings/" + key0.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/$defs/GuildBotConfig/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                        return false;
                      }
                    }
                    var valid2 = _errs10 === errors;
                    if (!valid2) {
                      break;
                    }
                  }
                }
              }
              var valid0 = _errs7 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.created_at !== void 0) {
                const _errs16 = errors;
                if (typeof data.created_at !== "string") {
                  validate34.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid0 = _errs16 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.description !== void 0) {
                  let data7 = data.description;
                  const _errs18 = errors;
                  if (typeof data7 !== "string" && data7 !== null) {
                    validate34.errors = [{ instancePath: instancePath + "/description", schemaPath: "#/properties/description/type", keyword: "type", params: { type: schema54.properties.description.type }, message: "must be string,null" }];
                    return false;
                  }
                  var valid0 = _errs18 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.discovery_tags !== void 0) {
                    let data8 = data.discovery_tags;
                    const _errs20 = errors;
                    if (errors === _errs20) {
                      if (Array.isArray(data8)) {
                        var valid5 = true;
                        const len1 = data8.length;
                        for (let i1 = 0; i1 < len1; i1++) {
                          const _errs22 = errors;
                          if (typeof data8[i1] !== "string") {
                            validate34.errors = [{ instancePath: instancePath + "/discovery_tags/" + i1, schemaPath: "#/properties/discovery_tags/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                            return false;
                          }
                          var valid5 = _errs22 === errors;
                          if (!valid5) {
                            break;
                          }
                        }
                      } else {
                        validate34.errors = [{ instancePath: instancePath + "/discovery_tags", schemaPath: "#/properties/discovery_tags/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
                        return false;
                      }
                    }
                    var valid0 = _errs20 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.hub_settings !== void 0) {
                      let data10 = data.hub_settings;
                      const _errs24 = errors;
                      const _errs25 = errors;
                      let valid6 = false;
                      const _errs26 = errors;
                      const _errs27 = errors;
                      if (errors === _errs27) {
                        if (data10 && typeof data10 == "object" && !Array.isArray(data10)) {
                          if (data10.description !== void 0) {
                            let data11 = data10.description;
                            const _errs30 = errors;
                            if (typeof data11 !== "string" && data11 !== null) {
                              const err0 = { instancePath: instancePath + "/hub_settings/description", schemaPath: "#/$defs/HubSettings/properties/description/type", keyword: "type", params: { type: schema56.properties.description.type }, message: "must be string,null" };
                              if (vErrors === null) {
                                vErrors = [err0];
                              } else {
                                vErrors.push(err0);
                              }
                              errors++;
                            }
                            var valid8 = _errs30 === errors;
                          } else {
                            var valid8 = true;
                          }
                          if (valid8) {
                            if (data10.pinned_channels !== void 0) {
                              let data12 = data10.pinned_channels;
                              const _errs32 = errors;
                              if (!Array.isArray(data12) && data12 !== null) {
                                const err1 = { instancePath: instancePath + "/hub_settings/pinned_channels", schemaPath: "#/$defs/HubSettings/properties/pinned_channels/type", keyword: "type", params: { type: schema56.properties.pinned_channels.type }, message: "must be array,null" };
                                if (vErrors === null) {
                                  vErrors = [err1];
                                } else {
                                  vErrors.push(err1);
                                }
                                errors++;
                              }
                              if (errors === _errs32) {
                                if (Array.isArray(data12)) {
                                  var valid9 = true;
                                  const len2 = data12.length;
                                  for (let i2 = 0; i2 < len2; i2++) {
                                    const _errs34 = errors;
                                    if (typeof data12[i2] !== "string") {
                                      const err2 = { instancePath: instancePath + "/hub_settings/pinned_channels/" + i2, schemaPath: "#/$defs/HubSettings/properties/pinned_channels/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                      if (vErrors === null) {
                                        vErrors = [err2];
                                      } else {
                                        vErrors.push(err2);
                                      }
                                      errors++;
                                    }
                                    var valid9 = _errs34 === errors;
                                    if (!valid9) {
                                      break;
                                    }
                                  }
                                }
                              }
                              var valid8 = _errs32 === errors;
                            } else {
                              var valid8 = true;
                            }
                            if (valid8) {
                              if (data10.welcome_text !== void 0) {
                                let data14 = data10.welcome_text;
                                const _errs36 = errors;
                                if (typeof data14 !== "string" && data14 !== null) {
                                  const err3 = { instancePath: instancePath + "/hub_settings/welcome_text", schemaPath: "#/$defs/HubSettings/properties/welcome_text/type", keyword: "type", params: { type: schema56.properties.welcome_text.type }, message: "must be string,null" };
                                  if (vErrors === null) {
                                    vErrors = [err3];
                                  } else {
                                    vErrors.push(err3);
                                  }
                                  errors++;
                                }
                                var valid8 = _errs36 === errors;
                              } else {
                                var valid8 = true;
                              }
                            }
                          }
                        } else {
                          const err4 = { instancePath: instancePath + "/hub_settings", schemaPath: "#/$defs/HubSettings/type", keyword: "type", params: { type: "object" }, message: "must be object" };
                          if (vErrors === null) {
                            vErrors = [err4];
                          } else {
                            vErrors.push(err4);
                          }
                          errors++;
                        }
                      }
                      var _valid0 = _errs26 === errors;
                      valid6 = valid6 || _valid0;
                      const _errs38 = errors;
                      if (data10 !== null) {
                        const err5 = { instancePath: instancePath + "/hub_settings", schemaPath: "#/properties/hub_settings/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                        if (vErrors === null) {
                          vErrors = [err5];
                        } else {
                          vErrors.push(err5);
                        }
                        errors++;
                      }
                      var _valid0 = _errs38 === errors;
                      valid6 = valid6 || _valid0;
                      if (!valid6) {
                        const err6 = { instancePath: instancePath + "/hub_settings", schemaPath: "#/properties/hub_settings/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                        if (vErrors === null) {
                          vErrors = [err6];
                        } else {
                          vErrors.push(err6);
                        }
                        errors++;
                        validate34.errors = vErrors;
                        return false;
                      } else {
                        errors = _errs25;
                        if (vErrors !== null) {
                          if (_errs25) {
                            vErrors.length = _errs25;
                          } else {
                            vErrors = null;
                          }
                        }
                      }
                      var valid0 = _errs24 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.icon_hash !== void 0) {
                        let data15 = data.icon_hash;
                        const _errs40 = errors;
                        if (typeof data15 !== "string" && data15 !== null) {
                          validate34.errors = [{ instancePath: instancePath + "/icon_hash", schemaPath: "#/properties/icon_hash/type", keyword: "type", params: { type: schema54.properties.icon_hash.type }, message: "must be string,null" }];
                          return false;
                        }
                        var valid0 = _errs40 === errors;
                      } else {
                        var valid0 = true;
                      }
                      if (valid0) {
                        if (data.id !== void 0) {
                          const _errs42 = errors;
                          if (typeof data.id !== "string") {
                            validate34.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                            return false;
                          }
                          var valid0 = _errs42 === errors;
                        } else {
                          var valid0 = true;
                        }
                        if (valid0) {
                          if (data.member_count !== void 0) {
                            let data17 = data.member_count;
                            const _errs44 = errors;
                            if (!(typeof data17 == "number" && (!(data17 % 1) && !isNaN(data17)) && isFinite(data17))) {
                              validate34.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                              return false;
                            }
                            if (errors === _errs44) {
                              if (typeof data17 == "number" && isFinite(data17)) {
                                if (data17 > 4294967295 || isNaN(data17)) {
                                  validate34.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" }];
                                  return false;
                                } else {
                                  if (data17 < 0 || isNaN(data17)) {
                                    validate34.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                    return false;
                                  }
                                }
                              }
                            }
                            var valid0 = _errs44 === errors;
                          } else {
                            var valid0 = true;
                          }
                          if (valid0) {
                            if (data.name !== void 0) {
                              const _errs46 = errors;
                              if (typeof data.name !== "string") {
                                validate34.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                return false;
                              }
                              var valid0 = _errs46 === errors;
                            } else {
                              var valid0 = true;
                            }
                            if (valid0) {
                              if (data.owner_id !== void 0) {
                                const _errs48 = errors;
                                if (typeof data.owner_id !== "string") {
                                  validate34.errors = [{ instancePath: instancePath + "/owner_id", schemaPath: "#/properties/owner_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                  return false;
                                }
                                var valid0 = _errs48 === errors;
                              } else {
                                var valid0 = true;
                              }
                              if (valid0) {
                                if (data.visibility !== void 0) {
                                  let data20 = data.visibility;
                                  const _errs50 = errors;
                                  if (typeof data20 !== "string") {
                                    validate34.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/$defs/GuildVisibility/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                    return false;
                                  }
                                  if (!(data20 === "private" || data20 === "public" || data20 === "roles")) {
                                    validate34.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/$defs/GuildVisibility/enum", keyword: "enum", params: { allowedValues: schema57.enum }, message: "must be equal to one of the allowed values" }];
                                    return false;
                                  }
                                  var valid0 = _errs50 === errors;
                                } else {
                                  var valid0 = true;
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate34.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate34.errors = vErrors;
  return errors === 0;
}
validate34.evaluated = { "props": { "allowed_roles": true, "banner_hash": true, "bot_settings": true, "created_at": true, "description": true, "discovery_tags": true, "hub_settings": true, "icon_hash": true, "id": true, "member_count": true, "name": true, "owner_id": true, "visibility": true }, "dynamicProps": false, "dynamicItems": false };
function validate33(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate33.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (Array.isArray(data)) {
      var valid0 = true;
      const len0 = data.length;
      for (let i0 = 0; i0 < len0; i0++) {
        const _errs1 = errors;
        if (!validate34(data[i0], { instancePath: instancePath + "/" + i0, parentData: data, parentDataProperty: i0, rootData, dynamicAnchors })) {
          vErrors = vErrors === null ? validate34.errors : vErrors.concat(validate34.errors);
          errors = vErrors.length;
        }
        var valid0 = _errs1 === errors;
        if (!valid0) {
          break;
        }
      }
    } else {
      validate33.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
      return false;
    }
  }
  validate33.errors = vErrors;
  return errors === 0;
}
validate33.evaluated = { "items": true, "dynamicProps": false, "dynamicItems": false };
var isInviteAcceptResponse = validate36;
var schema59 = { "description": "The guild card returned after successfully accepting an invite.", "properties": { "created_at": { "type": "string" }, "default_channel_id": { "description": "First usable channel for post-join navigation.", "type": ["string", "null"] }, "description": { "type": ["string", "null"] }, "icon_hash": { "type": ["string", "null"] }, "id": { "type": "string" }, "member_count": { "format": "uint32", "maximum": 4294967295, "minimum": 0, "type": "integer" }, "name": { "type": "string" }, "owner_id": { "type": "string" } }, "required": ["id", "name", "description", "icon_hash", "owner_id", "created_at", "default_channel_id", "member_count"], "type": "object" };
function validate36(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate36.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.guild === void 0 && (missing0 = "guild")) {
        validate36.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.guild !== void 0) {
          let data0 = data.guild;
          const _errs2 = errors;
          if (errors === _errs2) {
            if (data0 && typeof data0 == "object" && !Array.isArray(data0)) {
              let missing1;
              if (data0.id === void 0 && (missing1 = "id") || data0.name === void 0 && (missing1 = "name") || data0.description === void 0 && (missing1 = "description") || data0.icon_hash === void 0 && (missing1 = "icon_hash") || data0.owner_id === void 0 && (missing1 = "owner_id") || data0.created_at === void 0 && (missing1 = "created_at") || data0.default_channel_id === void 0 && (missing1 = "default_channel_id") || data0.member_count === void 0 && (missing1 = "member_count")) {
                validate36.errors = [{ instancePath: instancePath + "/guild", schemaPath: "#/$defs/InviteAcceptGuild/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                return false;
              } else {
                if (data0.created_at !== void 0) {
                  const _errs4 = errors;
                  if (typeof data0.created_at !== "string") {
                    validate36.errors = [{ instancePath: instancePath + "/guild/created_at", schemaPath: "#/$defs/InviteAcceptGuild/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                  var valid2 = _errs4 === errors;
                } else {
                  var valid2 = true;
                }
                if (valid2) {
                  if (data0.default_channel_id !== void 0) {
                    let data2 = data0.default_channel_id;
                    const _errs6 = errors;
                    if (typeof data2 !== "string" && data2 !== null) {
                      validate36.errors = [{ instancePath: instancePath + "/guild/default_channel_id", schemaPath: "#/$defs/InviteAcceptGuild/properties/default_channel_id/type", keyword: "type", params: { type: schema59.properties.default_channel_id.type }, message: "must be string,null" }];
                      return false;
                    }
                    var valid2 = _errs6 === errors;
                  } else {
                    var valid2 = true;
                  }
                  if (valid2) {
                    if (data0.description !== void 0) {
                      let data3 = data0.description;
                      const _errs8 = errors;
                      if (typeof data3 !== "string" && data3 !== null) {
                        validate36.errors = [{ instancePath: instancePath + "/guild/description", schemaPath: "#/$defs/InviteAcceptGuild/properties/description/type", keyword: "type", params: { type: schema59.properties.description.type }, message: "must be string,null" }];
                        return false;
                      }
                      var valid2 = _errs8 === errors;
                    } else {
                      var valid2 = true;
                    }
                    if (valid2) {
                      if (data0.icon_hash !== void 0) {
                        let data4 = data0.icon_hash;
                        const _errs10 = errors;
                        if (typeof data4 !== "string" && data4 !== null) {
                          validate36.errors = [{ instancePath: instancePath + "/guild/icon_hash", schemaPath: "#/$defs/InviteAcceptGuild/properties/icon_hash/type", keyword: "type", params: { type: schema59.properties.icon_hash.type }, message: "must be string,null" }];
                          return false;
                        }
                        var valid2 = _errs10 === errors;
                      } else {
                        var valid2 = true;
                      }
                      if (valid2) {
                        if (data0.id !== void 0) {
                          const _errs12 = errors;
                          if (typeof data0.id !== "string") {
                            validate36.errors = [{ instancePath: instancePath + "/guild/id", schemaPath: "#/$defs/InviteAcceptGuild/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                            return false;
                          }
                          var valid2 = _errs12 === errors;
                        } else {
                          var valid2 = true;
                        }
                        if (valid2) {
                          if (data0.member_count !== void 0) {
                            let data6 = data0.member_count;
                            const _errs14 = errors;
                            if (!(typeof data6 == "number" && (!(data6 % 1) && !isNaN(data6)) && isFinite(data6))) {
                              validate36.errors = [{ instancePath: instancePath + "/guild/member_count", schemaPath: "#/$defs/InviteAcceptGuild/properties/member_count/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                              return false;
                            }
                            if (errors === _errs14) {
                              if (typeof data6 == "number" && isFinite(data6)) {
                                if (data6 > 4294967295 || isNaN(data6)) {
                                  validate36.errors = [{ instancePath: instancePath + "/guild/member_count", schemaPath: "#/$defs/InviteAcceptGuild/properties/member_count/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" }];
                                  return false;
                                } else {
                                  if (data6 < 0 || isNaN(data6)) {
                                    validate36.errors = [{ instancePath: instancePath + "/guild/member_count", schemaPath: "#/$defs/InviteAcceptGuild/properties/member_count/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                    return false;
                                  }
                                }
                              }
                            }
                            var valid2 = _errs14 === errors;
                          } else {
                            var valid2 = true;
                          }
                          if (valid2) {
                            if (data0.name !== void 0) {
                              const _errs16 = errors;
                              if (typeof data0.name !== "string") {
                                validate36.errors = [{ instancePath: instancePath + "/guild/name", schemaPath: "#/$defs/InviteAcceptGuild/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                return false;
                              }
                              var valid2 = _errs16 === errors;
                            } else {
                              var valid2 = true;
                            }
                            if (valid2) {
                              if (data0.owner_id !== void 0) {
                                const _errs18 = errors;
                                if (typeof data0.owner_id !== "string") {
                                  validate36.errors = [{ instancePath: instancePath + "/guild/owner_id", schemaPath: "#/$defs/InviteAcceptGuild/properties/owner_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                  return false;
                                }
                                var valid2 = _errs18 === errors;
                              } else {
                                var valid2 = true;
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            } else {
              validate36.errors = [{ instancePath: instancePath + "/guild", schemaPath: "#/$defs/InviteAcceptGuild/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
              return false;
            }
          }
        }
      }
    } else {
      validate36.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate36.errors = vErrors;
  return errors === 0;
}
validate36.evaluated = { "props": { "guild": true }, "dynamicProps": false, "dynamicItems": false };
var isInvitePreview = validate37;
var schema61 = { "description": "The guild card embedded in `GET /invites/{code}`.", "properties": { "icon_hash": { "type": ["string", "null"] }, "id": { "type": "string" }, "member_count": { "format": "uint32", "maximum": 4294967295, "minimum": 0, "type": "integer" }, "name": { "type": "string" } }, "required": ["id", "name", "icon_hash", "member_count"], "type": "object" };
function validate37(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate37.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.code === void 0 && (missing0 = "code") || data.guild === void 0 && (missing0 = "guild")) {
        validate37.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.code !== void 0) {
          const _errs1 = errors;
          if (typeof data.code !== "string") {
            validate37.errors = [{ instancePath: instancePath + "/code", schemaPath: "#/properties/code/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.guild !== void 0) {
            let data1 = data.guild;
            const _errs3 = errors;
            const _errs4 = errors;
            let valid1 = false;
            const _errs5 = errors;
            const _errs6 = errors;
            if (errors === _errs6) {
              if (data1 && typeof data1 == "object" && !Array.isArray(data1)) {
                let missing1;
                if (data1.id === void 0 && (missing1 = "id") || data1.name === void 0 && (missing1 = "name") || data1.icon_hash === void 0 && (missing1 = "icon_hash") || data1.member_count === void 0 && (missing1 = "member_count")) {
                  const err0 = { instancePath: instancePath + "/guild", schemaPath: "#/$defs/InviteGuildPreview/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" };
                  if (vErrors === null) {
                    vErrors = [err0];
                  } else {
                    vErrors.push(err0);
                  }
                  errors++;
                } else {
                  if (data1.icon_hash !== void 0) {
                    let data2 = data1.icon_hash;
                    const _errs8 = errors;
                    if (typeof data2 !== "string" && data2 !== null) {
                      const err1 = { instancePath: instancePath + "/guild/icon_hash", schemaPath: "#/$defs/InviteGuildPreview/properties/icon_hash/type", keyword: "type", params: { type: schema61.properties.icon_hash.type }, message: "must be string,null" };
                      if (vErrors === null) {
                        vErrors = [err1];
                      } else {
                        vErrors.push(err1);
                      }
                      errors++;
                    }
                    var valid3 = _errs8 === errors;
                  } else {
                    var valid3 = true;
                  }
                  if (valid3) {
                    if (data1.id !== void 0) {
                      const _errs10 = errors;
                      if (typeof data1.id !== "string") {
                        const err2 = { instancePath: instancePath + "/guild/id", schemaPath: "#/$defs/InviteGuildPreview/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                        if (vErrors === null) {
                          vErrors = [err2];
                        } else {
                          vErrors.push(err2);
                        }
                        errors++;
                      }
                      var valid3 = _errs10 === errors;
                    } else {
                      var valid3 = true;
                    }
                    if (valid3) {
                      if (data1.member_count !== void 0) {
                        let data4 = data1.member_count;
                        const _errs12 = errors;
                        if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
                          const err3 = { instancePath: instancePath + "/guild/member_count", schemaPath: "#/$defs/InviteGuildPreview/properties/member_count/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
                          if (vErrors === null) {
                            vErrors = [err3];
                          } else {
                            vErrors.push(err3);
                          }
                          errors++;
                        }
                        if (errors === _errs12) {
                          if (typeof data4 == "number" && isFinite(data4)) {
                            if (data4 > 4294967295 || isNaN(data4)) {
                              const err4 = { instancePath: instancePath + "/guild/member_count", schemaPath: "#/$defs/InviteGuildPreview/properties/member_count/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" };
                              if (vErrors === null) {
                                vErrors = [err4];
                              } else {
                                vErrors.push(err4);
                              }
                              errors++;
                            } else {
                              if (data4 < 0 || isNaN(data4)) {
                                const err5 = { instancePath: instancePath + "/guild/member_count", schemaPath: "#/$defs/InviteGuildPreview/properties/member_count/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
                                if (vErrors === null) {
                                  vErrors = [err5];
                                } else {
                                  vErrors.push(err5);
                                }
                                errors++;
                              }
                            }
                          }
                        }
                        var valid3 = _errs12 === errors;
                      } else {
                        var valid3 = true;
                      }
                      if (valid3) {
                        if (data1.name !== void 0) {
                          const _errs14 = errors;
                          if (typeof data1.name !== "string") {
                            const err6 = { instancePath: instancePath + "/guild/name", schemaPath: "#/$defs/InviteGuildPreview/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                            if (vErrors === null) {
                              vErrors = [err6];
                            } else {
                              vErrors.push(err6);
                            }
                            errors++;
                          }
                          var valid3 = _errs14 === errors;
                        } else {
                          var valid3 = true;
                        }
                      }
                    }
                  }
                }
              } else {
                const err7 = { instancePath: instancePath + "/guild", schemaPath: "#/$defs/InviteGuildPreview/type", keyword: "type", params: { type: "object" }, message: "must be object" };
                if (vErrors === null) {
                  vErrors = [err7];
                } else {
                  vErrors.push(err7);
                }
                errors++;
              }
            }
            var _valid0 = _errs5 === errors;
            valid1 = valid1 || _valid0;
            if (_valid0) {
              var props0 = {};
              props0.icon_hash = true;
              props0.id = true;
              props0.member_count = true;
              props0.name = true;
            }
            const _errs16 = errors;
            if (data1 !== null) {
              const err8 = { instancePath: instancePath + "/guild", schemaPath: "#/properties/guild/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
              if (vErrors === null) {
                vErrors = [err8];
              } else {
                vErrors.push(err8);
              }
              errors++;
            }
            var _valid0 = _errs16 === errors;
            valid1 = valid1 || _valid0;
            if (!valid1) {
              const err9 = { instancePath: instancePath + "/guild", schemaPath: "#/properties/guild/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
              if (vErrors === null) {
                vErrors = [err9];
              } else {
                vErrors.push(err9);
              }
              errors++;
              validate37.errors = vErrors;
              return false;
            } else {
              errors = _errs4;
              if (vErrors !== null) {
                if (_errs4) {
                  vErrors.length = _errs4;
                } else {
                  vErrors = null;
                }
              }
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.join_gate !== void 0) {
              let data6 = data.join_gate;
              const _errs18 = errors;
              const _errs19 = errors;
              let valid4 = false;
              const _errs20 = errors;
              const _errs21 = errors;
              if (errors === _errs21) {
                if (data6 && typeof data6 == "object" && !Array.isArray(data6)) {
                  let missing2;
                  if (data6.require_ack === void 0 && (missing2 = "require_ack") || data6.questions === void 0 && (missing2 = "questions")) {
                    const err10 = { instancePath: instancePath + "/join_gate", schemaPath: "#/$defs/InviteJoinGate/required", keyword: "required", params: { missingProperty: missing2 }, message: "must have required property '" + missing2 + "'" };
                    if (vErrors === null) {
                      vErrors = [err10];
                    } else {
                      vErrors.push(err10);
                    }
                    errors++;
                  } else {
                    if (data6.questions !== void 0) {
                      let data7 = data6.questions;
                      const _errs23 = errors;
                      if (errors === _errs23) {
                        if (Array.isArray(data7)) {
                          var valid7 = true;
                          const len0 = data7.length;
                          for (let i0 = 0; i0 < len0; i0++) {
                            const _errs25 = errors;
                            if (typeof data7[i0] !== "string") {
                              const err11 = { instancePath: instancePath + "/join_gate/questions/" + i0, schemaPath: "#/$defs/InviteJoinGate/properties/questions/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                              if (vErrors === null) {
                                vErrors = [err11];
                              } else {
                                vErrors.push(err11);
                              }
                              errors++;
                            }
                            var valid7 = _errs25 === errors;
                            if (!valid7) {
                              break;
                            }
                          }
                        } else {
                          const err12 = { instancePath: instancePath + "/join_gate/questions", schemaPath: "#/$defs/InviteJoinGate/properties/questions/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                          if (vErrors === null) {
                            vErrors = [err12];
                          } else {
                            vErrors.push(err12);
                          }
                          errors++;
                        }
                      }
                      var valid6 = _errs23 === errors;
                    } else {
                      var valid6 = true;
                    }
                    if (valid6) {
                      if (data6.require_ack !== void 0) {
                        const _errs27 = errors;
                        if (typeof data6.require_ack !== "boolean") {
                          const err13 = { instancePath: instancePath + "/join_gate/require_ack", schemaPath: "#/$defs/InviteJoinGate/properties/require_ack/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" };
                          if (vErrors === null) {
                            vErrors = [err13];
                          } else {
                            vErrors.push(err13);
                          }
                          errors++;
                        }
                        var valid6 = _errs27 === errors;
                      } else {
                        var valid6 = true;
                      }
                    }
                  }
                } else {
                  const err14 = { instancePath: instancePath + "/join_gate", schemaPath: "#/$defs/InviteJoinGate/type", keyword: "type", params: { type: "object" }, message: "must be object" };
                  if (vErrors === null) {
                    vErrors = [err14];
                  } else {
                    vErrors.push(err14);
                  }
                  errors++;
                }
              }
              var _valid1 = _errs20 === errors;
              valid4 = valid4 || _valid1;
              if (_valid1) {
                var props1 = {};
                props1.questions = true;
                props1.require_ack = true;
              }
              const _errs29 = errors;
              if (data6 !== null) {
                const err15 = { instancePath: instancePath + "/join_gate", schemaPath: "#/properties/join_gate/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                if (vErrors === null) {
                  vErrors = [err15];
                } else {
                  vErrors.push(err15);
                }
                errors++;
              }
              var _valid1 = _errs29 === errors;
              valid4 = valid4 || _valid1;
              if (!valid4) {
                const err16 = { instancePath: instancePath + "/join_gate", schemaPath: "#/properties/join_gate/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                if (vErrors === null) {
                  vErrors = [err16];
                } else {
                  vErrors.push(err16);
                }
                errors++;
                validate37.errors = vErrors;
                return false;
              } else {
                errors = _errs19;
                if (vErrors !== null) {
                  if (_errs19) {
                    vErrors.length = _errs19;
                  } else {
                    vErrors = null;
                  }
                }
              }
              var valid0 = _errs18 === errors;
            } else {
              var valid0 = true;
            }
          }
        }
      }
    } else {
      validate37.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate37.errors = vErrors;
  return errors === 0;
}
validate37.evaluated = { "props": { "code": true, "guild": true, "join_gate": true }, "dynamicProps": false, "dynamicItems": false };
var isOwnershipTransferResponse = validate38;
function validate38(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate38.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.id === void 0 && (missing0 = "id") || data.owner_id === void 0 && (missing0 = "owner_id")) {
        validate38.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.id !== void 0) {
          const _errs1 = errors;
          if (typeof data.id !== "string") {
            validate38.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.owner_id !== void 0) {
            const _errs3 = errors;
            if (typeof data.owner_id !== "string") {
              validate38.errors = [{ instancePath: instancePath + "/owner_id", schemaPath: "#/properties/owner_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
        }
      }
    } else {
      validate38.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate38.errors = vErrors;
  return errors === 0;
}
validate38.evaluated = { "props": { "id": true, "owner_id": true }, "dynamicProps": false, "dynamicItems": false };
var isPublicUserProfile = validate39;
var schema65 = { "description": "A friend shared by the viewer and the profile subject.", "properties": { "avatar_hash": { "type": ["string", "null"] }, "discriminator": { "format": "int32", "type": "integer" }, "id": { "type": "string" }, "username": { "type": "string" } }, "required": ["id", "username", "discriminator", "avatar_hash"], "type": "object" };
var schema66 = { "description": "A guild shared by the viewer and the profile subject. `icon_url` is the\npersisted icon hash; the wire name predates the `icon_hash` convention.", "properties": { "icon_url": { "type": ["string", "null"] }, "id": { "type": "string" }, "name": { "type": "string" } }, "required": ["id", "name", "icon_url"], "type": "object" };
var schema68 = { "description": "The user object embedded in the public profile response.", "properties": { "accent_color": { "description": "Profile accent as `0xRRGGBB`. Omitted when the member has not chosen one.\n\nNew in 3.2. Unlike the other nullable fields it may be absent rather\nthan null, so a 3.2 client can still read accounts from a 3.1 instance,\nwhich never sends it.", "format": "int32", "type": ["integer", "null"] }, "avatar_hash": { "type": ["string", "null"] }, "banner_hash": { "type": ["string", "null"] }, "bio": { "type": ["string", "null"] }, "bot": { "type": "boolean" }, "created_at": { "type": "string" }, "discriminator": { "format": "int32", "type": "integer" }, "display_name": { "type": ["string", "null"] }, "flags": { "format": "int32", "type": "integer" }, "id": { "type": "string" }, "linked_accounts": { "items": { "$ref": "#/$defs/LinkedAccount" }, "type": "array" }, "pronouns": { "type": ["string", "null"] }, "system": { "type": "boolean" }, "username": { "type": "string" } }, "required": ["id", "username", "discriminator", "display_name", "avatar_hash", "banner_hash", "bio", "flags", "bot", "system", "created_at", "pronouns", "linked_accounts"], "type": "object" };
function validate40(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate40.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.id === void 0 && (missing0 = "id") || data.username === void 0 && (missing0 = "username") || data.discriminator === void 0 && (missing0 = "discriminator") || data.display_name === void 0 && (missing0 = "display_name") || data.avatar_hash === void 0 && (missing0 = "avatar_hash") || data.banner_hash === void 0 && (missing0 = "banner_hash") || data.bio === void 0 && (missing0 = "bio") || data.flags === void 0 && (missing0 = "flags") || data.bot === void 0 && (missing0 = "bot") || data.system === void 0 && (missing0 = "system") || data.created_at === void 0 && (missing0 = "created_at") || data.pronouns === void 0 && (missing0 = "pronouns") || data.linked_accounts === void 0 && (missing0 = "linked_accounts")) {
        validate40.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.accent_color !== void 0) {
          let data0 = data.accent_color;
          const _errs1 = errors;
          if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)) && isFinite(data0)) && data0 !== null) {
            validate40.errors = [{ instancePath: instancePath + "/accent_color", schemaPath: "#/properties/accent_color/type", keyword: "type", params: { type: schema68.properties.accent_color.type }, message: "must be integer,null" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.avatar_hash !== void 0) {
            let data1 = data.avatar_hash;
            const _errs3 = errors;
            if (typeof data1 !== "string" && data1 !== null) {
              validate40.errors = [{ instancePath: instancePath + "/avatar_hash", schemaPath: "#/properties/avatar_hash/type", keyword: "type", params: { type: schema68.properties.avatar_hash.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.banner_hash !== void 0) {
              let data2 = data.banner_hash;
              const _errs5 = errors;
              if (typeof data2 !== "string" && data2 !== null) {
                validate40.errors = [{ instancePath: instancePath + "/banner_hash", schemaPath: "#/properties/banner_hash/type", keyword: "type", params: { type: schema68.properties.banner_hash.type }, message: "must be string,null" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.bio !== void 0) {
                let data3 = data.bio;
                const _errs7 = errors;
                if (typeof data3 !== "string" && data3 !== null) {
                  validate40.errors = [{ instancePath: instancePath + "/bio", schemaPath: "#/properties/bio/type", keyword: "type", params: { type: schema68.properties.bio.type }, message: "must be string,null" }];
                  return false;
                }
                var valid0 = _errs7 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.bot !== void 0) {
                  const _errs9 = errors;
                  if (typeof data.bot !== "boolean") {
                    validate40.errors = [{ instancePath: instancePath + "/bot", schemaPath: "#/properties/bot/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                    return false;
                  }
                  var valid0 = _errs9 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.created_at !== void 0) {
                    const _errs11 = errors;
                    if (typeof data.created_at !== "string") {
                      validate40.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid0 = _errs11 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.discriminator !== void 0) {
                      let data6 = data.discriminator;
                      const _errs13 = errors;
                      if (!(typeof data6 == "number" && (!(data6 % 1) && !isNaN(data6)) && isFinite(data6))) {
                        validate40.errors = [{ instancePath: instancePath + "/discriminator", schemaPath: "#/properties/discriminator/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      var valid0 = _errs13 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.display_name !== void 0) {
                        let data7 = data.display_name;
                        const _errs15 = errors;
                        if (typeof data7 !== "string" && data7 !== null) {
                          validate40.errors = [{ instancePath: instancePath + "/display_name", schemaPath: "#/properties/display_name/type", keyword: "type", params: { type: schema68.properties.display_name.type }, message: "must be string,null" }];
                          return false;
                        }
                        var valid0 = _errs15 === errors;
                      } else {
                        var valid0 = true;
                      }
                      if (valid0) {
                        if (data.flags !== void 0) {
                          let data8 = data.flags;
                          const _errs17 = errors;
                          if (!(typeof data8 == "number" && (!(data8 % 1) && !isNaN(data8)) && isFinite(data8))) {
                            validate40.errors = [{ instancePath: instancePath + "/flags", schemaPath: "#/properties/flags/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                            return false;
                          }
                          var valid0 = _errs17 === errors;
                        } else {
                          var valid0 = true;
                        }
                        if (valid0) {
                          if (data.id !== void 0) {
                            const _errs19 = errors;
                            if (typeof data.id !== "string") {
                              validate40.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                              return false;
                            }
                            var valid0 = _errs19 === errors;
                          } else {
                            var valid0 = true;
                          }
                          if (valid0) {
                            if (data.linked_accounts !== void 0) {
                              let data10 = data.linked_accounts;
                              const _errs21 = errors;
                              if (errors === _errs21) {
                                if (Array.isArray(data10)) {
                                  var valid1 = true;
                                  const len0 = data10.length;
                                  for (let i0 = 0; i0 < len0; i0++) {
                                    let data11 = data10[i0];
                                    const _errs23 = errors;
                                    const _errs24 = errors;
                                    if (errors === _errs24) {
                                      if (data11 && typeof data11 == "object" && !Array.isArray(data11)) {
                                        let missing1;
                                        if (data11.label === void 0 && (missing1 = "label") || data11.url === void 0 && (missing1 = "url")) {
                                          validate40.errors = [{ instancePath: instancePath + "/linked_accounts/" + i0, schemaPath: "#/$defs/LinkedAccount/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                                          return false;
                                        } else {
                                          if (data11.label !== void 0) {
                                            const _errs26 = errors;
                                            if (typeof data11.label !== "string") {
                                              validate40.errors = [{ instancePath: instancePath + "/linked_accounts/" + i0 + "/label", schemaPath: "#/$defs/LinkedAccount/properties/label/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                              return false;
                                            }
                                            var valid3 = _errs26 === errors;
                                          } else {
                                            var valid3 = true;
                                          }
                                          if (valid3) {
                                            if (data11.url !== void 0) {
                                              const _errs28 = errors;
                                              if (typeof data11.url !== "string") {
                                                validate40.errors = [{ instancePath: instancePath + "/linked_accounts/" + i0 + "/url", schemaPath: "#/$defs/LinkedAccount/properties/url/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                                return false;
                                              }
                                              var valid3 = _errs28 === errors;
                                            } else {
                                              var valid3 = true;
                                            }
                                          }
                                        }
                                      } else {
                                        validate40.errors = [{ instancePath: instancePath + "/linked_accounts/" + i0, schemaPath: "#/$defs/LinkedAccount/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                                        return false;
                                      }
                                    }
                                    var valid1 = _errs23 === errors;
                                    if (!valid1) {
                                      break;
                                    }
                                  }
                                } else {
                                  validate40.errors = [{ instancePath: instancePath + "/linked_accounts", schemaPath: "#/properties/linked_accounts/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
                                  return false;
                                }
                              }
                              var valid0 = _errs21 === errors;
                            } else {
                              var valid0 = true;
                            }
                            if (valid0) {
                              if (data.pronouns !== void 0) {
                                let data14 = data.pronouns;
                                const _errs30 = errors;
                                if (typeof data14 !== "string" && data14 !== null) {
                                  validate40.errors = [{ instancePath: instancePath + "/pronouns", schemaPath: "#/properties/pronouns/type", keyword: "type", params: { type: schema68.properties.pronouns.type }, message: "must be string,null" }];
                                  return false;
                                }
                                var valid0 = _errs30 === errors;
                              } else {
                                var valid0 = true;
                              }
                              if (valid0) {
                                if (data.system !== void 0) {
                                  const _errs32 = errors;
                                  if (typeof data.system !== "boolean") {
                                    validate40.errors = [{ instancePath: instancePath + "/system", schemaPath: "#/properties/system/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                                    return false;
                                  }
                                  var valid0 = _errs32 === errors;
                                } else {
                                  var valid0 = true;
                                }
                                if (valid0) {
                                  if (data.username !== void 0) {
                                    const _errs34 = errors;
                                    if (typeof data.username !== "string") {
                                      validate40.errors = [{ instancePath: instancePath + "/username", schemaPath: "#/properties/username/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                      return false;
                                    }
                                    var valid0 = _errs34 === errors;
                                  } else {
                                    var valid0 = true;
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate40.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate40.errors = vErrors;
  return errors === 0;
}
validate40.evaluated = { "props": { "accent_color": true, "avatar_hash": true, "banner_hash": true, "bio": true, "bot": true, "created_at": true, "discriminator": true, "display_name": true, "flags": true, "id": true, "linked_accounts": true, "pronouns": true, "system": true, "username": true }, "dynamicProps": false, "dynamicItems": false };
function validate39(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate39.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.user === void 0 && (missing0 = "user") || data.roles === void 0 && (missing0 = "roles") || data.mutual_guilds === void 0 && (missing0 = "mutual_guilds") || data.mutual_friends === void 0 && (missing0 = "mutual_friends") || data.created_at === void 0 && (missing0 = "created_at")) {
        validate39.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.created_at !== void 0) {
          const _errs1 = errors;
          if (typeof data.created_at !== "string") {
            validate39.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.mutual_friends !== void 0) {
            let data1 = data.mutual_friends;
            const _errs3 = errors;
            if (errors === _errs3) {
              if (Array.isArray(data1)) {
                var valid1 = true;
                const len0 = data1.length;
                for (let i0 = 0; i0 < len0; i0++) {
                  let data2 = data1[i0];
                  const _errs5 = errors;
                  const _errs6 = errors;
                  if (errors === _errs6) {
                    if (data2 && typeof data2 == "object" && !Array.isArray(data2)) {
                      let missing1;
                      if (data2.id === void 0 && (missing1 = "id") || data2.username === void 0 && (missing1 = "username") || data2.discriminator === void 0 && (missing1 = "discriminator") || data2.avatar_hash === void 0 && (missing1 = "avatar_hash")) {
                        validate39.errors = [{ instancePath: instancePath + "/mutual_friends/" + i0, schemaPath: "#/$defs/MutualFriend/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                        return false;
                      } else {
                        if (data2.avatar_hash !== void 0) {
                          let data3 = data2.avatar_hash;
                          const _errs8 = errors;
                          if (typeof data3 !== "string" && data3 !== null) {
                            validate39.errors = [{ instancePath: instancePath + "/mutual_friends/" + i0 + "/avatar_hash", schemaPath: "#/$defs/MutualFriend/properties/avatar_hash/type", keyword: "type", params: { type: schema65.properties.avatar_hash.type }, message: "must be string,null" }];
                            return false;
                          }
                          var valid3 = _errs8 === errors;
                        } else {
                          var valid3 = true;
                        }
                        if (valid3) {
                          if (data2.discriminator !== void 0) {
                            let data4 = data2.discriminator;
                            const _errs10 = errors;
                            if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
                              validate39.errors = [{ instancePath: instancePath + "/mutual_friends/" + i0 + "/discriminator", schemaPath: "#/$defs/MutualFriend/properties/discriminator/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                              return false;
                            }
                            var valid3 = _errs10 === errors;
                          } else {
                            var valid3 = true;
                          }
                          if (valid3) {
                            if (data2.id !== void 0) {
                              const _errs12 = errors;
                              if (typeof data2.id !== "string") {
                                validate39.errors = [{ instancePath: instancePath + "/mutual_friends/" + i0 + "/id", schemaPath: "#/$defs/MutualFriend/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                return false;
                              }
                              var valid3 = _errs12 === errors;
                            } else {
                              var valid3 = true;
                            }
                            if (valid3) {
                              if (data2.username !== void 0) {
                                const _errs14 = errors;
                                if (typeof data2.username !== "string") {
                                  validate39.errors = [{ instancePath: instancePath + "/mutual_friends/" + i0 + "/username", schemaPath: "#/$defs/MutualFriend/properties/username/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                  return false;
                                }
                                var valid3 = _errs14 === errors;
                              } else {
                                var valid3 = true;
                              }
                            }
                          }
                        }
                      }
                    } else {
                      validate39.errors = [{ instancePath: instancePath + "/mutual_friends/" + i0, schemaPath: "#/$defs/MutualFriend/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                      return false;
                    }
                  }
                  var valid1 = _errs5 === errors;
                  if (!valid1) {
                    break;
                  }
                }
              } else {
                validate39.errors = [{ instancePath: instancePath + "/mutual_friends", schemaPath: "#/properties/mutual_friends/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
                return false;
              }
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.mutual_guilds !== void 0) {
              let data7 = data.mutual_guilds;
              const _errs16 = errors;
              if (errors === _errs16) {
                if (Array.isArray(data7)) {
                  var valid4 = true;
                  const len1 = data7.length;
                  for (let i1 = 0; i1 < len1; i1++) {
                    let data8 = data7[i1];
                    const _errs18 = errors;
                    const _errs19 = errors;
                    if (errors === _errs19) {
                      if (data8 && typeof data8 == "object" && !Array.isArray(data8)) {
                        let missing2;
                        if (data8.id === void 0 && (missing2 = "id") || data8.name === void 0 && (missing2 = "name") || data8.icon_url === void 0 && (missing2 = "icon_url")) {
                          validate39.errors = [{ instancePath: instancePath + "/mutual_guilds/" + i1, schemaPath: "#/$defs/MutualGuild/required", keyword: "required", params: { missingProperty: missing2 }, message: "must have required property '" + missing2 + "'" }];
                          return false;
                        } else {
                          if (data8.icon_url !== void 0) {
                            let data9 = data8.icon_url;
                            const _errs21 = errors;
                            if (typeof data9 !== "string" && data9 !== null) {
                              validate39.errors = [{ instancePath: instancePath + "/mutual_guilds/" + i1 + "/icon_url", schemaPath: "#/$defs/MutualGuild/properties/icon_url/type", keyword: "type", params: { type: schema66.properties.icon_url.type }, message: "must be string,null" }];
                              return false;
                            }
                            var valid6 = _errs21 === errors;
                          } else {
                            var valid6 = true;
                          }
                          if (valid6) {
                            if (data8.id !== void 0) {
                              const _errs23 = errors;
                              if (typeof data8.id !== "string") {
                                validate39.errors = [{ instancePath: instancePath + "/mutual_guilds/" + i1 + "/id", schemaPath: "#/$defs/MutualGuild/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                return false;
                              }
                              var valid6 = _errs23 === errors;
                            } else {
                              var valid6 = true;
                            }
                            if (valid6) {
                              if (data8.name !== void 0) {
                                const _errs25 = errors;
                                if (typeof data8.name !== "string") {
                                  validate39.errors = [{ instancePath: instancePath + "/mutual_guilds/" + i1 + "/name", schemaPath: "#/$defs/MutualGuild/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                  return false;
                                }
                                var valid6 = _errs25 === errors;
                              } else {
                                var valid6 = true;
                              }
                            }
                          }
                        }
                      } else {
                        validate39.errors = [{ instancePath: instancePath + "/mutual_guilds/" + i1, schemaPath: "#/$defs/MutualGuild/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                        return false;
                      }
                    }
                    var valid4 = _errs18 === errors;
                    if (!valid4) {
                      break;
                    }
                  }
                } else {
                  validate39.errors = [{ instancePath: instancePath + "/mutual_guilds", schemaPath: "#/properties/mutual_guilds/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
                  return false;
                }
              }
              var valid0 = _errs16 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.roles !== void 0) {
                let data12 = data.roles;
                const _errs27 = errors;
                if (errors === _errs27) {
                  if (Array.isArray(data12)) {
                    var valid7 = true;
                    const len2 = data12.length;
                    for (let i2 = 0; i2 < len2; i2++) {
                      let data13 = data12[i2];
                      const _errs29 = errors;
                      const _errs30 = errors;
                      if (errors === _errs30) {
                        if (data13 && typeof data13 == "object" && !Array.isArray(data13)) {
                          let missing3;
                          if (data13.id === void 0 && (missing3 = "id") || data13.guild_id === void 0 && (missing3 = "guild_id") || data13.name === void 0 && (missing3 = "name") || data13.color === void 0 && (missing3 = "color") || data13.hoist === void 0 && (missing3 = "hoist") || data13.position === void 0 && (missing3 = "position") || data13.permissions === void 0 && (missing3 = "permissions") || data13.mentionable === void 0 && (missing3 = "mentionable") || data13.created_at === void 0 && (missing3 = "created_at")) {
                            validate39.errors = [{ instancePath: instancePath + "/roles/" + i2, schemaPath: "#/$defs/ProfileRole/required", keyword: "required", params: { missingProperty: missing3 }, message: "must have required property '" + missing3 + "'" }];
                            return false;
                          } else {
                            if (data13.color !== void 0) {
                              let data14 = data13.color;
                              const _errs32 = errors;
                              if (!(typeof data14 == "number" && (!(data14 % 1) && !isNaN(data14)) && isFinite(data14))) {
                                validate39.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/color", schemaPath: "#/$defs/ProfileRole/properties/color/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                                return false;
                              }
                              var valid9 = _errs32 === errors;
                            } else {
                              var valid9 = true;
                            }
                            if (valid9) {
                              if (data13.created_at !== void 0) {
                                const _errs34 = errors;
                                if (typeof data13.created_at !== "string") {
                                  validate39.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/created_at", schemaPath: "#/$defs/ProfileRole/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                  return false;
                                }
                                var valid9 = _errs34 === errors;
                              } else {
                                var valid9 = true;
                              }
                              if (valid9) {
                                if (data13.guild_id !== void 0) {
                                  const _errs36 = errors;
                                  if (typeof data13.guild_id !== "string") {
                                    validate39.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/guild_id", schemaPath: "#/$defs/ProfileRole/properties/guild_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                    return false;
                                  }
                                  var valid9 = _errs36 === errors;
                                } else {
                                  var valid9 = true;
                                }
                                if (valid9) {
                                  if (data13.hoist !== void 0) {
                                    const _errs38 = errors;
                                    if (typeof data13.hoist !== "boolean") {
                                      validate39.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/hoist", schemaPath: "#/$defs/ProfileRole/properties/hoist/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                                      return false;
                                    }
                                    var valid9 = _errs38 === errors;
                                  } else {
                                    var valid9 = true;
                                  }
                                  if (valid9) {
                                    if (data13.id !== void 0) {
                                      const _errs40 = errors;
                                      if (typeof data13.id !== "string") {
                                        validate39.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/id", schemaPath: "#/$defs/ProfileRole/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                        return false;
                                      }
                                      var valid9 = _errs40 === errors;
                                    } else {
                                      var valid9 = true;
                                    }
                                    if (valid9) {
                                      if (data13.mentionable !== void 0) {
                                        const _errs42 = errors;
                                        if (typeof data13.mentionable !== "boolean") {
                                          validate39.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/mentionable", schemaPath: "#/$defs/ProfileRole/properties/mentionable/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                                          return false;
                                        }
                                        var valid9 = _errs42 === errors;
                                      } else {
                                        var valid9 = true;
                                      }
                                      if (valid9) {
                                        if (data13.name !== void 0) {
                                          const _errs44 = errors;
                                          if (typeof data13.name !== "string") {
                                            validate39.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/name", schemaPath: "#/$defs/ProfileRole/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                            return false;
                                          }
                                          var valid9 = _errs44 === errors;
                                        } else {
                                          var valid9 = true;
                                        }
                                        if (valid9) {
                                          if (data13.permissions !== void 0) {
                                            const _errs46 = errors;
                                            if (typeof data13.permissions !== "string") {
                                              validate39.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/permissions", schemaPath: "#/$defs/ProfileRole/properties/permissions/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                              return false;
                                            }
                                            var valid9 = _errs46 === errors;
                                          } else {
                                            var valid9 = true;
                                          }
                                          if (valid9) {
                                            if (data13.position !== void 0) {
                                              let data22 = data13.position;
                                              const _errs48 = errors;
                                              if (!(typeof data22 == "number" && (!(data22 % 1) && !isNaN(data22)) && isFinite(data22))) {
                                                validate39.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/position", schemaPath: "#/$defs/ProfileRole/properties/position/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                                                return false;
                                              }
                                              var valid9 = _errs48 === errors;
                                            } else {
                                              var valid9 = true;
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        } else {
                          validate39.errors = [{ instancePath: instancePath + "/roles/" + i2, schemaPath: "#/$defs/ProfileRole/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                          return false;
                        }
                      }
                      var valid7 = _errs29 === errors;
                      if (!valid7) {
                        break;
                      }
                    }
                  } else {
                    validate39.errors = [{ instancePath: instancePath + "/roles", schemaPath: "#/properties/roles/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
                    return false;
                  }
                }
                var valid0 = _errs27 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.user !== void 0) {
                  const _errs50 = errors;
                  if (!validate40(data.user, { instancePath: instancePath + "/user", parentData: data, parentDataProperty: "user", rootData, dynamicAnchors })) {
                    vErrors = vErrors === null ? validate40.errors : vErrors.concat(validate40.errors);
                    errors = vErrors.length;
                  }
                  var valid0 = _errs50 === errors;
                } else {
                  var valid0 = true;
                }
              }
            }
          }
        }
      }
    } else {
      validate39.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate39.errors = vErrors;
  return errors === 0;
}
validate39.evaluated = { "props": { "created_at": true, "mutual_friends": true, "mutual_guilds": true, "roles": true, "user": true }, "dynamicProps": false, "dynamicItems": false };
var isReadyGuildCore = validate42;
var schema70 = { "$id": "urn:paracord:contract:ReadyGuildCore", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "Persisted space metadata carried by the gateway READY payload.\nDistinct from `GuildSummary`: READY sends only durable fields, never the\nREST settings surface. Nullable fields are present, including when null.", "properties": { "created_at": { "minLength": 1, "type": "string" }, "icon_hash": { "type": ["string", "null"] }, "id": { "minLength": 1, "pattern": "\\S", "type": "string" }, "member_count": { "format": "uint32", "maximum": 4294967295, "minimum": 0, "type": "integer" }, "name": { "minLength": 1, "pattern": "\\S", "type": "string" }, "owner_id": { "minLength": 1, "pattern": "\\S", "type": "string" } }, "required": ["id", "owner_id", "name", "icon_hash", "created_at", "member_count"], "title": "ReadyGuildCore", "type": "object" };
var func1 = require_ucs2length().default;
var pattern4 = new RegExp("\\S", "u");
function validate42(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate42.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.id === void 0 && (missing0 = "id") || data.owner_id === void 0 && (missing0 = "owner_id") || data.name === void 0 && (missing0 = "name") || data.icon_hash === void 0 && (missing0 = "icon_hash") || data.created_at === void 0 && (missing0 = "created_at") || data.member_count === void 0 && (missing0 = "member_count")) {
        validate42.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.created_at !== void 0) {
          let data0 = data.created_at;
          const _errs1 = errors;
          if (errors === _errs1) {
            if (typeof data0 === "string") {
              if (func1(data0) < 1) {
                validate42.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                return false;
              }
            } else {
              validate42.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.icon_hash !== void 0) {
            let data1 = data.icon_hash;
            const _errs3 = errors;
            if (typeof data1 !== "string" && data1 !== null) {
              validate42.errors = [{ instancePath: instancePath + "/icon_hash", schemaPath: "#/properties/icon_hash/type", keyword: "type", params: { type: schema70.properties.icon_hash.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.id !== void 0) {
              let data2 = data.id;
              const _errs5 = errors;
              if (errors === _errs5) {
                if (typeof data2 === "string") {
                  if (func1(data2) < 1) {
                    validate42.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                    return false;
                  } else {
                    if (!pattern4.test(data2)) {
                      validate42.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/pattern", keyword: "pattern", params: { pattern: "\\S" }, message: 'must match pattern "\\S"' }];
                      return false;
                    }
                  }
                } else {
                  validate42.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.member_count !== void 0) {
                let data3 = data.member_count;
                const _errs7 = errors;
                if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3))) {
                  validate42.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                  return false;
                }
                if (errors === _errs7) {
                  if (typeof data3 == "number" && isFinite(data3)) {
                    if (data3 > 4294967295 || isNaN(data3)) {
                      validate42.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" }];
                      return false;
                    } else {
                      if (data3 < 0 || isNaN(data3)) {
                        validate42.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                        return false;
                      }
                    }
                  }
                }
                var valid0 = _errs7 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.name !== void 0) {
                  let data4 = data.name;
                  const _errs9 = errors;
                  if (errors === _errs9) {
                    if (typeof data4 === "string") {
                      if (func1(data4) < 1) {
                        validate42.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                        return false;
                      } else {
                        if (!pattern4.test(data4)) {
                          validate42.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/pattern", keyword: "pattern", params: { pattern: "\\S" }, message: 'must match pattern "\\S"' }];
                          return false;
                        }
                      }
                    } else {
                      validate42.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                  }
                  var valid0 = _errs9 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.owner_id !== void 0) {
                    let data5 = data.owner_id;
                    const _errs11 = errors;
                    if (errors === _errs11) {
                      if (typeof data5 === "string") {
                        if (func1(data5) < 1) {
                          validate42.errors = [{ instancePath: instancePath + "/owner_id", schemaPath: "#/properties/owner_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                          return false;
                        } else {
                          if (!pattern4.test(data5)) {
                            validate42.errors = [{ instancePath: instancePath + "/owner_id", schemaPath: "#/properties/owner_id/pattern", keyword: "pattern", params: { pattern: "\\S" }, message: 'must match pattern "\\S"' }];
                            return false;
                          }
                        }
                      } else {
                        validate42.errors = [{ instancePath: instancePath + "/owner_id", schemaPath: "#/properties/owner_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                        return false;
                      }
                    }
                    var valid0 = _errs11 === errors;
                  } else {
                    var valid0 = true;
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate42.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate42.errors = vErrors;
  return errors === 0;
}
validate42.evaluated = { "props": { "created_at": true, "icon_hash": true, "id": true, "member_count": true, "name": true, "owner_id": true }, "dynamicProps": false, "dynamicItems": false };
var isRelationshipList = validate43;
var schema73 = { "description": "The other party's identity embedded in a relationship entry.\nNullable fields are present in responses, including when their value is null.", "properties": { "avatar_hash": { "type": ["string", "null"] }, "discriminator": { "format": "int32", "type": "integer" }, "display_name": { "type": ["string", "null"] }, "id": { "type": "string" }, "username": { "type": "string" } }, "required": ["id", "username", "display_name", "discriminator", "avatar_hash"], "type": "object" };
function validate44(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate44.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.id === void 0 && (missing0 = "id") || data.user_id === void 0 && (missing0 = "user_id") || data.target_id === void 0 && (missing0 = "target_id") || data.type === void 0 && (missing0 = "type") || data.rel_type === void 0 && (missing0 = "rel_type") || data.created_at === void 0 && (missing0 = "created_at") || data.user === void 0 && (missing0 = "user")) {
        validate44.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.created_at !== void 0) {
          const _errs1 = errors;
          if (typeof data.created_at !== "string") {
            validate44.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.id !== void 0) {
            const _errs3 = errors;
            if (typeof data.id !== "string") {
              validate44.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.rel_type !== void 0) {
              let data2 = data.rel_type;
              const _errs5 = errors;
              if (!(typeof data2 == "number" && (!(data2 % 1) && !isNaN(data2)) && isFinite(data2))) {
                validate44.errors = [{ instancePath: instancePath + "/rel_type", schemaPath: "#/properties/rel_type/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.target_id !== void 0) {
                const _errs7 = errors;
                if (typeof data.target_id !== "string") {
                  validate44.errors = [{ instancePath: instancePath + "/target_id", schemaPath: "#/properties/target_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid0 = _errs7 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.type !== void 0) {
                  let data4 = data.type;
                  const _errs9 = errors;
                  if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
                    validate44.errors = [{ instancePath: instancePath + "/type", schemaPath: "#/properties/type/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                    return false;
                  }
                  var valid0 = _errs9 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.user !== void 0) {
                    let data5 = data.user;
                    const _errs11 = errors;
                    const _errs12 = errors;
                    if (errors === _errs12) {
                      if (data5 && typeof data5 == "object" && !Array.isArray(data5)) {
                        let missing1;
                        if (data5.id === void 0 && (missing1 = "id") || data5.username === void 0 && (missing1 = "username") || data5.display_name === void 0 && (missing1 = "display_name") || data5.discriminator === void 0 && (missing1 = "discriminator") || data5.avatar_hash === void 0 && (missing1 = "avatar_hash")) {
                          validate44.errors = [{ instancePath: instancePath + "/user", schemaPath: "#/$defs/RelationshipUser/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                          return false;
                        } else {
                          if (data5.avatar_hash !== void 0) {
                            let data6 = data5.avatar_hash;
                            const _errs14 = errors;
                            if (typeof data6 !== "string" && data6 !== null) {
                              validate44.errors = [{ instancePath: instancePath + "/user/avatar_hash", schemaPath: "#/$defs/RelationshipUser/properties/avatar_hash/type", keyword: "type", params: { type: schema73.properties.avatar_hash.type }, message: "must be string,null" }];
                              return false;
                            }
                            var valid2 = _errs14 === errors;
                          } else {
                            var valid2 = true;
                          }
                          if (valid2) {
                            if (data5.discriminator !== void 0) {
                              let data7 = data5.discriminator;
                              const _errs16 = errors;
                              if (!(typeof data7 == "number" && (!(data7 % 1) && !isNaN(data7)) && isFinite(data7))) {
                                validate44.errors = [{ instancePath: instancePath + "/user/discriminator", schemaPath: "#/$defs/RelationshipUser/properties/discriminator/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                                return false;
                              }
                              var valid2 = _errs16 === errors;
                            } else {
                              var valid2 = true;
                            }
                            if (valid2) {
                              if (data5.display_name !== void 0) {
                                let data8 = data5.display_name;
                                const _errs18 = errors;
                                if (typeof data8 !== "string" && data8 !== null) {
                                  validate44.errors = [{ instancePath: instancePath + "/user/display_name", schemaPath: "#/$defs/RelationshipUser/properties/display_name/type", keyword: "type", params: { type: schema73.properties.display_name.type }, message: "must be string,null" }];
                                  return false;
                                }
                                var valid2 = _errs18 === errors;
                              } else {
                                var valid2 = true;
                              }
                              if (valid2) {
                                if (data5.id !== void 0) {
                                  const _errs20 = errors;
                                  if (typeof data5.id !== "string") {
                                    validate44.errors = [{ instancePath: instancePath + "/user/id", schemaPath: "#/$defs/RelationshipUser/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                    return false;
                                  }
                                  var valid2 = _errs20 === errors;
                                } else {
                                  var valid2 = true;
                                }
                                if (valid2) {
                                  if (data5.username !== void 0) {
                                    const _errs22 = errors;
                                    if (typeof data5.username !== "string") {
                                      validate44.errors = [{ instancePath: instancePath + "/user/username", schemaPath: "#/$defs/RelationshipUser/properties/username/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                      return false;
                                    }
                                    var valid2 = _errs22 === errors;
                                  } else {
                                    var valid2 = true;
                                  }
                                }
                              }
                            }
                          }
                        }
                      } else {
                        validate44.errors = [{ instancePath: instancePath + "/user", schemaPath: "#/$defs/RelationshipUser/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                        return false;
                      }
                    }
                    var valid0 = _errs11 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.user_id !== void 0) {
                      const _errs24 = errors;
                      if (typeof data.user_id !== "string") {
                        validate44.errors = [{ instancePath: instancePath + "/user_id", schemaPath: "#/properties/user_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                        return false;
                      }
                      var valid0 = _errs24 === errors;
                    } else {
                      var valid0 = true;
                    }
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate44.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate44.errors = vErrors;
  return errors === 0;
}
validate44.evaluated = { "props": { "created_at": true, "id": true, "rel_type": true, "target_id": true, "type": true, "user": true, "user_id": true }, "dynamicProps": false, "dynamicItems": false };
function validate43(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate43.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (Array.isArray(data)) {
      var valid0 = true;
      const len0 = data.length;
      for (let i0 = 0; i0 < len0; i0++) {
        const _errs1 = errors;
        if (!validate44(data[i0], { instancePath: instancePath + "/" + i0, parentData: data, parentDataProperty: i0, rootData, dynamicAnchors })) {
          vErrors = vErrors === null ? validate44.errors : vErrors.concat(validate44.errors);
          errors = vErrors.length;
        }
        var valid0 = _errs1 === errors;
        if (!valid0) {
          break;
        }
      }
    } else {
      validate43.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
      return false;
    }
  }
  validate43.errors = vErrors;
  return errors === 0;
}
validate43.evaluated = { "items": true, "dynamicProps": false, "dynamicItems": false };
var isTransferOwnershipRequest = validate46;
function validate46(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate46.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.new_owner_id === void 0 && (missing0 = "new_owner_id")) {
        validate46.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.new_owner_id !== void 0) {
          if (typeof data.new_owner_id !== "string") {
            validate46.errors = [{ instancePath: instancePath + "/new_owner_id", schemaPath: "#/properties/new_owner_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
        }
      }
    } else {
      validate46.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate46.errors = vErrors;
  return errors === 0;
}
validate46.evaluated = { "props": { "new_owner_id": true }, "dynamicProps": false, "dynamicItems": false };
var isUpdatedCurrentUser = validate47;
var schema75 = { "$id": "urn:paracord:contract:UpdatedCurrentUser", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "`PATCH /users/@me` and `POST /users/@me/avatar`: the updated account fields.\nSettings-derived extras (pronouns, linked accounts) and key metadata are\nonly returned by `GET /users/@me`.", "properties": { "accent_color": { "description": "Profile accent as `0xRRGGBB`. Omitted when the member has not chosen one.\n\nNew in 3.2. Unlike the other nullable fields it may be absent rather\nthan null, so a 3.2 client can still read accounts from a 3.1 instance,\nwhich never sends it.", "format": "int32", "type": ["integer", "null"] }, "avatar_hash": { "type": ["string", "null"] }, "banner_hash": { "type": ["string", "null"] }, "bio": { "type": ["string", "null"] }, "bot": { "type": "boolean" }, "created_at": { "type": "string" }, "discriminator": { "format": "int32", "type": "integer" }, "display_name": { "type": ["string", "null"] }, "email": { "type": "string" }, "flags": { "format": "int32", "type": "integer" }, "id": { "type": "string" }, "system": { "type": "boolean" }, "username": { "type": "string" } }, "required": ["id", "username", "discriminator", "display_name", "avatar_hash", "banner_hash", "bio", "flags", "bot", "system", "created_at", "email"], "title": "UpdatedCurrentUser", "type": "object" };
function validate47(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate47.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.id === void 0 && (missing0 = "id") || data.username === void 0 && (missing0 = "username") || data.discriminator === void 0 && (missing0 = "discriminator") || data.display_name === void 0 && (missing0 = "display_name") || data.avatar_hash === void 0 && (missing0 = "avatar_hash") || data.banner_hash === void 0 && (missing0 = "banner_hash") || data.bio === void 0 && (missing0 = "bio") || data.flags === void 0 && (missing0 = "flags") || data.bot === void 0 && (missing0 = "bot") || data.system === void 0 && (missing0 = "system") || data.created_at === void 0 && (missing0 = "created_at") || data.email === void 0 && (missing0 = "email")) {
        validate47.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.accent_color !== void 0) {
          let data0 = data.accent_color;
          const _errs1 = errors;
          if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)) && isFinite(data0)) && data0 !== null) {
            validate47.errors = [{ instancePath: instancePath + "/accent_color", schemaPath: "#/properties/accent_color/type", keyword: "type", params: { type: schema75.properties.accent_color.type }, message: "must be integer,null" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.avatar_hash !== void 0) {
            let data1 = data.avatar_hash;
            const _errs3 = errors;
            if (typeof data1 !== "string" && data1 !== null) {
              validate47.errors = [{ instancePath: instancePath + "/avatar_hash", schemaPath: "#/properties/avatar_hash/type", keyword: "type", params: { type: schema75.properties.avatar_hash.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.banner_hash !== void 0) {
              let data2 = data.banner_hash;
              const _errs5 = errors;
              if (typeof data2 !== "string" && data2 !== null) {
                validate47.errors = [{ instancePath: instancePath + "/banner_hash", schemaPath: "#/properties/banner_hash/type", keyword: "type", params: { type: schema75.properties.banner_hash.type }, message: "must be string,null" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.bio !== void 0) {
                let data3 = data.bio;
                const _errs7 = errors;
                if (typeof data3 !== "string" && data3 !== null) {
                  validate47.errors = [{ instancePath: instancePath + "/bio", schemaPath: "#/properties/bio/type", keyword: "type", params: { type: schema75.properties.bio.type }, message: "must be string,null" }];
                  return false;
                }
                var valid0 = _errs7 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.bot !== void 0) {
                  const _errs9 = errors;
                  if (typeof data.bot !== "boolean") {
                    validate47.errors = [{ instancePath: instancePath + "/bot", schemaPath: "#/properties/bot/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                    return false;
                  }
                  var valid0 = _errs9 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.created_at !== void 0) {
                    const _errs11 = errors;
                    if (typeof data.created_at !== "string") {
                      validate47.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid0 = _errs11 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.discriminator !== void 0) {
                      let data6 = data.discriminator;
                      const _errs13 = errors;
                      if (!(typeof data6 == "number" && (!(data6 % 1) && !isNaN(data6)) && isFinite(data6))) {
                        validate47.errors = [{ instancePath: instancePath + "/discriminator", schemaPath: "#/properties/discriminator/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      var valid0 = _errs13 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.display_name !== void 0) {
                        let data7 = data.display_name;
                        const _errs15 = errors;
                        if (typeof data7 !== "string" && data7 !== null) {
                          validate47.errors = [{ instancePath: instancePath + "/display_name", schemaPath: "#/properties/display_name/type", keyword: "type", params: { type: schema75.properties.display_name.type }, message: "must be string,null" }];
                          return false;
                        }
                        var valid0 = _errs15 === errors;
                      } else {
                        var valid0 = true;
                      }
                      if (valid0) {
                        if (data.email !== void 0) {
                          const _errs17 = errors;
                          if (typeof data.email !== "string") {
                            validate47.errors = [{ instancePath: instancePath + "/email", schemaPath: "#/properties/email/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                            return false;
                          }
                          var valid0 = _errs17 === errors;
                        } else {
                          var valid0 = true;
                        }
                        if (valid0) {
                          if (data.flags !== void 0) {
                            let data9 = data.flags;
                            const _errs19 = errors;
                            if (!(typeof data9 == "number" && (!(data9 % 1) && !isNaN(data9)) && isFinite(data9))) {
                              validate47.errors = [{ instancePath: instancePath + "/flags", schemaPath: "#/properties/flags/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                              return false;
                            }
                            var valid0 = _errs19 === errors;
                          } else {
                            var valid0 = true;
                          }
                          if (valid0) {
                            if (data.id !== void 0) {
                              const _errs21 = errors;
                              if (typeof data.id !== "string") {
                                validate47.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                return false;
                              }
                              var valid0 = _errs21 === errors;
                            } else {
                              var valid0 = true;
                            }
                            if (valid0) {
                              if (data.system !== void 0) {
                                const _errs23 = errors;
                                if (typeof data.system !== "boolean") {
                                  validate47.errors = [{ instancePath: instancePath + "/system", schemaPath: "#/properties/system/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                                  return false;
                                }
                                var valid0 = _errs23 === errors;
                              } else {
                                var valid0 = true;
                              }
                              if (valid0) {
                                if (data.username !== void 0) {
                                  const _errs25 = errors;
                                  if (typeof data.username !== "string") {
                                    validate47.errors = [{ instancePath: instancePath + "/username", schemaPath: "#/properties/username/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                    return false;
                                  }
                                  var valid0 = _errs25 === errors;
                                } else {
                                  var valid0 = true;
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate47.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate47.errors = vErrors;
  return errors === 0;
}
validate47.evaluated = { "props": { "accent_color": true, "avatar_hash": true, "banner_hash": true, "bio": true, "bot": true, "created_at": true, "discriminator": true, "display_name": true, "email": true, "flags": true, "id": true, "system": true, "username": true }, "dynamicProps": false, "dynamicItems": false };
var isUpdateEmojiRequest = validate48;
function validate48(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate48.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.name === void 0 && (missing0 = "name")) {
        validate48.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.name !== void 0) {
          if (typeof data.name !== "string") {
            validate48.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
        }
      }
    } else {
      validate48.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate48.errors = vErrors;
  return errors === 0;
}
validate48.evaluated = { "props": { "name": true }, "dynamicProps": false, "dynamicItems": false };
var isUpdateGuildRequest = validate49;
var schema77 = { "$defs": { "GuildBotConfig": { "additionalProperties": true, "properties": { "enabled": { "type": ["boolean", "null"] } }, "type": "object" }, "HubSettings": { "additionalProperties": true, "properties": { "description": { "type": ["string", "null"] }, "pinned_channels": { "items": { "type": "string" }, "type": ["array", "null"] }, "welcome_text": { "type": ["string", "null"] } }, "type": "object" } }, "$id": "urn:paracord:contract:UpdateGuildRequest", "$schema": "https://json-schema.org/draft/2020-12/schema", "properties": { "allowed_roles": { "items": { "type": "string" }, "type": ["array", "null"] }, "bot_settings": { "additionalProperties": { "$ref": "#/$defs/GuildBotConfig" }, "type": ["object", "null"] }, "description": { "type": ["string", "null"] }, "discovery_tags": { "items": { "type": "string" }, "type": ["array", "null"] }, "hub_settings": { "anyOf": [{ "$ref": "#/$defs/HubSettings" }, { "type": "null" }] }, "icon": { "type": ["string", "null"] }, "name": { "type": ["string", "null"] }, "visibility": { "type": ["string", "null"] } }, "title": "UpdateGuildRequest", "type": "object" };
var schema78 = { "additionalProperties": true, "properties": { "enabled": { "type": ["boolean", "null"] } }, "type": "object" };
var schema79 = { "additionalProperties": true, "properties": { "description": { "type": ["string", "null"] }, "pinned_channels": { "items": { "type": "string" }, "type": ["array", "null"] }, "welcome_text": { "type": ["string", "null"] } }, "type": "object" };
function validate49(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate49.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      if (data.allowed_roles !== void 0) {
        let data0 = data.allowed_roles;
        const _errs1 = errors;
        if (!Array.isArray(data0) && data0 !== null) {
          validate49.errors = [{ instancePath: instancePath + "/allowed_roles", schemaPath: "#/properties/allowed_roles/type", keyword: "type", params: { type: schema77.properties.allowed_roles.type }, message: "must be array,null" }];
          return false;
        }
        if (errors === _errs1) {
          if (Array.isArray(data0)) {
            var valid1 = true;
            const len0 = data0.length;
            for (let i0 = 0; i0 < len0; i0++) {
              const _errs3 = errors;
              if (typeof data0[i0] !== "string") {
                validate49.errors = [{ instancePath: instancePath + "/allowed_roles/" + i0, schemaPath: "#/properties/allowed_roles/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              var valid1 = _errs3 === errors;
              if (!valid1) {
                break;
              }
            }
          }
        }
        var valid0 = _errs1 === errors;
      } else {
        var valid0 = true;
      }
      if (valid0) {
        if (data.bot_settings !== void 0) {
          let data2 = data.bot_settings;
          const _errs5 = errors;
          if (!(data2 && typeof data2 == "object" && !Array.isArray(data2)) && data2 !== null) {
            validate49.errors = [{ instancePath: instancePath + "/bot_settings", schemaPath: "#/properties/bot_settings/type", keyword: "type", params: { type: schema77.properties.bot_settings.type }, message: "must be object,null" }];
            return false;
          }
          if (errors === _errs5) {
            if (data2 && typeof data2 == "object" && !Array.isArray(data2)) {
              for (const key0 in data2) {
                let data3 = data2[key0];
                const _errs8 = errors;
                const _errs9 = errors;
                if (errors === _errs9) {
                  if (data3 && typeof data3 == "object" && !Array.isArray(data3)) {
                    if (data3.enabled !== void 0) {
                      let data4 = data3.enabled;
                      if (typeof data4 !== "boolean" && data4 !== null) {
                        validate49.errors = [{ instancePath: instancePath + "/bot_settings/" + key0.replace(/~/g, "~0").replace(/\//g, "~1") + "/enabled", schemaPath: "#/$defs/GuildBotConfig/properties/enabled/type", keyword: "type", params: { type: schema78.properties.enabled.type }, message: "must be boolean,null" }];
                        return false;
                      }
                    }
                  } else {
                    validate49.errors = [{ instancePath: instancePath + "/bot_settings/" + key0.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/$defs/GuildBotConfig/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                    return false;
                  }
                }
                var valid2 = _errs8 === errors;
                if (!valid2) {
                  break;
                }
              }
            }
          }
          var valid0 = _errs5 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.description !== void 0) {
            let data5 = data.description;
            const _errs14 = errors;
            if (typeof data5 !== "string" && data5 !== null) {
              validate49.errors = [{ instancePath: instancePath + "/description", schemaPath: "#/properties/description/type", keyword: "type", params: { type: schema77.properties.description.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs14 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.discovery_tags !== void 0) {
              let data6 = data.discovery_tags;
              const _errs16 = errors;
              if (!Array.isArray(data6) && data6 !== null) {
                validate49.errors = [{ instancePath: instancePath + "/discovery_tags", schemaPath: "#/properties/discovery_tags/type", keyword: "type", params: { type: schema77.properties.discovery_tags.type }, message: "must be array,null" }];
                return false;
              }
              if (errors === _errs16) {
                if (Array.isArray(data6)) {
                  var valid5 = true;
                  const len1 = data6.length;
                  for (let i1 = 0; i1 < len1; i1++) {
                    const _errs18 = errors;
                    if (typeof data6[i1] !== "string") {
                      validate49.errors = [{ instancePath: instancePath + "/discovery_tags/" + i1, schemaPath: "#/properties/discovery_tags/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid5 = _errs18 === errors;
                    if (!valid5) {
                      break;
                    }
                  }
                }
              }
              var valid0 = _errs16 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.hub_settings !== void 0) {
                let data8 = data.hub_settings;
                const _errs20 = errors;
                const _errs21 = errors;
                let valid6 = false;
                const _errs22 = errors;
                const _errs23 = errors;
                if (errors === _errs23) {
                  if (data8 && typeof data8 == "object" && !Array.isArray(data8)) {
                    if (data8.description !== void 0) {
                      let data9 = data8.description;
                      const _errs26 = errors;
                      if (typeof data9 !== "string" && data9 !== null) {
                        const err0 = { instancePath: instancePath + "/hub_settings/description", schemaPath: "#/$defs/HubSettings/properties/description/type", keyword: "type", params: { type: schema79.properties.description.type }, message: "must be string,null" };
                        if (vErrors === null) {
                          vErrors = [err0];
                        } else {
                          vErrors.push(err0);
                        }
                        errors++;
                      }
                      var valid8 = _errs26 === errors;
                    } else {
                      var valid8 = true;
                    }
                    if (valid8) {
                      if (data8.pinned_channels !== void 0) {
                        let data10 = data8.pinned_channels;
                        const _errs28 = errors;
                        if (!Array.isArray(data10) && data10 !== null) {
                          const err1 = { instancePath: instancePath + "/hub_settings/pinned_channels", schemaPath: "#/$defs/HubSettings/properties/pinned_channels/type", keyword: "type", params: { type: schema79.properties.pinned_channels.type }, message: "must be array,null" };
                          if (vErrors === null) {
                            vErrors = [err1];
                          } else {
                            vErrors.push(err1);
                          }
                          errors++;
                        }
                        if (errors === _errs28) {
                          if (Array.isArray(data10)) {
                            var valid9 = true;
                            const len2 = data10.length;
                            for (let i2 = 0; i2 < len2; i2++) {
                              const _errs30 = errors;
                              if (typeof data10[i2] !== "string") {
                                const err2 = { instancePath: instancePath + "/hub_settings/pinned_channels/" + i2, schemaPath: "#/$defs/HubSettings/properties/pinned_channels/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                if (vErrors === null) {
                                  vErrors = [err2];
                                } else {
                                  vErrors.push(err2);
                                }
                                errors++;
                              }
                              var valid9 = _errs30 === errors;
                              if (!valid9) {
                                break;
                              }
                            }
                          }
                        }
                        var valid8 = _errs28 === errors;
                      } else {
                        var valid8 = true;
                      }
                      if (valid8) {
                        if (data8.welcome_text !== void 0) {
                          let data12 = data8.welcome_text;
                          const _errs32 = errors;
                          if (typeof data12 !== "string" && data12 !== null) {
                            const err3 = { instancePath: instancePath + "/hub_settings/welcome_text", schemaPath: "#/$defs/HubSettings/properties/welcome_text/type", keyword: "type", params: { type: schema79.properties.welcome_text.type }, message: "must be string,null" };
                            if (vErrors === null) {
                              vErrors = [err3];
                            } else {
                              vErrors.push(err3);
                            }
                            errors++;
                          }
                          var valid8 = _errs32 === errors;
                        } else {
                          var valid8 = true;
                        }
                      }
                    }
                  } else {
                    const err4 = { instancePath: instancePath + "/hub_settings", schemaPath: "#/$defs/HubSettings/type", keyword: "type", params: { type: "object" }, message: "must be object" };
                    if (vErrors === null) {
                      vErrors = [err4];
                    } else {
                      vErrors.push(err4);
                    }
                    errors++;
                  }
                }
                var _valid0 = _errs22 === errors;
                valid6 = valid6 || _valid0;
                const _errs34 = errors;
                if (data8 !== null) {
                  const err5 = { instancePath: instancePath + "/hub_settings", schemaPath: "#/properties/hub_settings/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                  if (vErrors === null) {
                    vErrors = [err5];
                  } else {
                    vErrors.push(err5);
                  }
                  errors++;
                }
                var _valid0 = _errs34 === errors;
                valid6 = valid6 || _valid0;
                if (!valid6) {
                  const err6 = { instancePath: instancePath + "/hub_settings", schemaPath: "#/properties/hub_settings/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                  if (vErrors === null) {
                    vErrors = [err6];
                  } else {
                    vErrors.push(err6);
                  }
                  errors++;
                  validate49.errors = vErrors;
                  return false;
                } else {
                  errors = _errs21;
                  if (vErrors !== null) {
                    if (_errs21) {
                      vErrors.length = _errs21;
                    } else {
                      vErrors = null;
                    }
                  }
                }
                var valid0 = _errs20 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.icon !== void 0) {
                  let data13 = data.icon;
                  const _errs36 = errors;
                  if (typeof data13 !== "string" && data13 !== null) {
                    validate49.errors = [{ instancePath: instancePath + "/icon", schemaPath: "#/properties/icon/type", keyword: "type", params: { type: schema77.properties.icon.type }, message: "must be string,null" }];
                    return false;
                  }
                  var valid0 = _errs36 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.name !== void 0) {
                    let data14 = data.name;
                    const _errs38 = errors;
                    if (typeof data14 !== "string" && data14 !== null) {
                      validate49.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: schema77.properties.name.type }, message: "must be string,null" }];
                      return false;
                    }
                    var valid0 = _errs38 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.visibility !== void 0) {
                      let data15 = data.visibility;
                      const _errs40 = errors;
                      if (typeof data15 !== "string" && data15 !== null) {
                        validate49.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/properties/visibility/type", keyword: "type", params: { type: schema77.properties.visibility.type }, message: "must be string,null" }];
                        return false;
                      }
                      var valid0 = _errs40 === errors;
                    } else {
                      var valid0 = true;
                    }
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate49.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate49.errors = vErrors;
  return errors === 0;
}
validate49.evaluated = { "props": { "allowed_roles": true, "bot_settings": true, "description": true, "discovery_tags": true, "hub_settings": true, "icon": true, "name": true, "visibility": true }, "dynamicProps": false, "dynamicItems": false };
var isUpdateMeRequest = validate50;
var schema80 = { "$id": "urn:paracord:contract:UpdateMeRequest", "$schema": "https://json-schema.org/draft/2020-12/schema", "properties": { "accent_color": { "default": null, "description": "Profile accent as `0xRRGGBB`. `null` clears it. Omit the field to leave\nthe stored colour unchanged.", "format": "int32", "type": ["integer", "null"] }, "avatar_hash": { "description": "Legacy data-URL avatars are still accepted for backward compatibility,\nbut clients should prefer `POST /users/@me/avatar`.", "type": ["string", "null"] }, "bio": { "type": ["string", "null"] }, "display_name": { "type": ["string", "null"] } }, "title": "UpdateMeRequest", "type": "object" };
function validate50(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate50.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      if (data.accent_color !== void 0) {
        let data0 = data.accent_color;
        const _errs1 = errors;
        if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)) && isFinite(data0)) && data0 !== null) {
          validate50.errors = [{ instancePath: instancePath + "/accent_color", schemaPath: "#/properties/accent_color/type", keyword: "type", params: { type: schema80.properties.accent_color.type }, message: "must be integer,null" }];
          return false;
        }
        var valid0 = _errs1 === errors;
      } else {
        var valid0 = true;
      }
      if (valid0) {
        if (data.avatar_hash !== void 0) {
          let data1 = data.avatar_hash;
          const _errs3 = errors;
          if (typeof data1 !== "string" && data1 !== null) {
            validate50.errors = [{ instancePath: instancePath + "/avatar_hash", schemaPath: "#/properties/avatar_hash/type", keyword: "type", params: { type: schema80.properties.avatar_hash.type }, message: "must be string,null" }];
            return false;
          }
          var valid0 = _errs3 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.bio !== void 0) {
            let data2 = data.bio;
            const _errs5 = errors;
            if (typeof data2 !== "string" && data2 !== null) {
              validate50.errors = [{ instancePath: instancePath + "/bio", schemaPath: "#/properties/bio/type", keyword: "type", params: { type: schema80.properties.bio.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs5 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.display_name !== void 0) {
              let data3 = data.display_name;
              const _errs7 = errors;
              if (typeof data3 !== "string" && data3 !== null) {
                validate50.errors = [{ instancePath: instancePath + "/display_name", schemaPath: "#/properties/display_name/type", keyword: "type", params: { type: schema80.properties.display_name.type }, message: "must be string,null" }];
                return false;
              }
              var valid0 = _errs7 === errors;
            } else {
              var valid0 = true;
            }
          }
        }
      }
    } else {
      validate50.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate50.errors = vErrors;
  return errors === 0;
}
validate50.evaluated = { "props": { "accent_color": true, "avatar_hash": true, "bio": true, "display_name": true }, "dynamicProps": false, "dynamicItems": false };
var isUpdateSettingsRequest = validate51;
var schema81 = { "$id": "urn:paracord:contract:UpdateSettingsRequest", "$schema": "https://json-schema.org/draft/2020-12/schema", "properties": { "crypto_auth_enabled": { "type": ["boolean", "null"] }, "custom_css": { "type": ["string", "null"] }, "custom_status": { "type": ["string", "null"] }, "keybinds": true, "locale": { "type": ["string", "null"] }, "message_display_compact": { "type": ["boolean", "null"] }, "notifications": true, "status": { "type": ["string", "null"] }, "theme": { "type": ["string", "null"] } }, "title": "UpdateSettingsRequest", "type": "object" };
function validate51(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate51.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      if (data.crypto_auth_enabled !== void 0) {
        let data0 = data.crypto_auth_enabled;
        const _errs1 = errors;
        if (typeof data0 !== "boolean" && data0 !== null) {
          validate51.errors = [{ instancePath: instancePath + "/crypto_auth_enabled", schemaPath: "#/properties/crypto_auth_enabled/type", keyword: "type", params: { type: schema81.properties.crypto_auth_enabled.type }, message: "must be boolean,null" }];
          return false;
        }
        var valid0 = _errs1 === errors;
      } else {
        var valid0 = true;
      }
      if (valid0) {
        if (data.custom_css !== void 0) {
          let data1 = data.custom_css;
          const _errs3 = errors;
          if (typeof data1 !== "string" && data1 !== null) {
            validate51.errors = [{ instancePath: instancePath + "/custom_css", schemaPath: "#/properties/custom_css/type", keyword: "type", params: { type: schema81.properties.custom_css.type }, message: "must be string,null" }];
            return false;
          }
          var valid0 = _errs3 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.custom_status !== void 0) {
            let data2 = data.custom_status;
            const _errs5 = errors;
            if (typeof data2 !== "string" && data2 !== null) {
              validate51.errors = [{ instancePath: instancePath + "/custom_status", schemaPath: "#/properties/custom_status/type", keyword: "type", params: { type: schema81.properties.custom_status.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs5 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.locale !== void 0) {
              let data3 = data.locale;
              const _errs7 = errors;
              if (typeof data3 !== "string" && data3 !== null) {
                validate51.errors = [{ instancePath: instancePath + "/locale", schemaPath: "#/properties/locale/type", keyword: "type", params: { type: schema81.properties.locale.type }, message: "must be string,null" }];
                return false;
              }
              var valid0 = _errs7 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.message_display_compact !== void 0) {
                let data4 = data.message_display_compact;
                const _errs9 = errors;
                if (typeof data4 !== "boolean" && data4 !== null) {
                  validate51.errors = [{ instancePath: instancePath + "/message_display_compact", schemaPath: "#/properties/message_display_compact/type", keyword: "type", params: { type: schema81.properties.message_display_compact.type }, message: "must be boolean,null" }];
                  return false;
                }
                var valid0 = _errs9 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.status !== void 0) {
                  let data5 = data.status;
                  const _errs11 = errors;
                  if (typeof data5 !== "string" && data5 !== null) {
                    validate51.errors = [{ instancePath: instancePath + "/status", schemaPath: "#/properties/status/type", keyword: "type", params: { type: schema81.properties.status.type }, message: "must be string,null" }];
                    return false;
                  }
                  var valid0 = _errs11 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.theme !== void 0) {
                    let data6 = data.theme;
                    const _errs13 = errors;
                    if (typeof data6 !== "string" && data6 !== null) {
                      validate51.errors = [{ instancePath: instancePath + "/theme", schemaPath: "#/properties/theme/type", keyword: "type", params: { type: schema81.properties.theme.type }, message: "must be string,null" }];
                      return false;
                    }
                    var valid0 = _errs13 === errors;
                  } else {
                    var valid0 = true;
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate51.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate51.errors = vErrors;
  return errors === 0;
}
validate51.evaluated = { "props": { "crypto_auth_enabled": true, "custom_css": true, "custom_status": true, "keybinds": true, "locale": true, "message_display_compact": true, "notifications": true, "status": true, "theme": true }, "dynamicProps": false, "dynamicItems": false };
var isUserSettingsResponse = validate52;
var schema82 = { "$id": "urn:paracord:contract:UserSettingsResponse", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "`GET`/`PATCH /users/@me/settings`. The server stores `theme`, `locale`, and\n`status` as opaque strings (bounded by length only), and `notifications` and\n`keybinds` as free-form JSON objects; they are echoed verbatim.", "properties": { "crypto_auth_enabled": { "type": "boolean" }, "custom_css": { "type": ["string", "null"] }, "custom_status": { "type": ["string", "null"] }, "keybinds": { "additionalProperties": true, "type": "object" }, "locale": { "type": "string" }, "message_display_compact": { "type": "boolean" }, "notifications": { "additionalProperties": true, "type": "object" }, "status": { "type": "string" }, "theme": { "type": "string" }, "user_id": { "type": "string" } }, "required": ["user_id", "theme", "locale", "message_display_compact", "custom_css", "status", "custom_status", "crypto_auth_enabled", "notifications", "keybinds"], "title": "UserSettingsResponse", "type": "object" };
function validate52(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate52.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.user_id === void 0 && (missing0 = "user_id") || data.theme === void 0 && (missing0 = "theme") || data.locale === void 0 && (missing0 = "locale") || data.message_display_compact === void 0 && (missing0 = "message_display_compact") || data.custom_css === void 0 && (missing0 = "custom_css") || data.status === void 0 && (missing0 = "status") || data.custom_status === void 0 && (missing0 = "custom_status") || data.crypto_auth_enabled === void 0 && (missing0 = "crypto_auth_enabled") || data.notifications === void 0 && (missing0 = "notifications") || data.keybinds === void 0 && (missing0 = "keybinds")) {
        validate52.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.crypto_auth_enabled !== void 0) {
          const _errs1 = errors;
          if (typeof data.crypto_auth_enabled !== "boolean") {
            validate52.errors = [{ instancePath: instancePath + "/crypto_auth_enabled", schemaPath: "#/properties/crypto_auth_enabled/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.custom_css !== void 0) {
            let data1 = data.custom_css;
            const _errs3 = errors;
            if (typeof data1 !== "string" && data1 !== null) {
              validate52.errors = [{ instancePath: instancePath + "/custom_css", schemaPath: "#/properties/custom_css/type", keyword: "type", params: { type: schema82.properties.custom_css.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.custom_status !== void 0) {
              let data2 = data.custom_status;
              const _errs5 = errors;
              if (typeof data2 !== "string" && data2 !== null) {
                validate52.errors = [{ instancePath: instancePath + "/custom_status", schemaPath: "#/properties/custom_status/type", keyword: "type", params: { type: schema82.properties.custom_status.type }, message: "must be string,null" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.keybinds !== void 0) {
                let data3 = data.keybinds;
                const _errs7 = errors;
                if (errors === _errs7) {
                  if (data3 && typeof data3 == "object" && !Array.isArray(data3)) {
                  } else {
                    validate52.errors = [{ instancePath: instancePath + "/keybinds", schemaPath: "#/properties/keybinds/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                    return false;
                  }
                }
                var valid0 = _errs7 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.locale !== void 0) {
                  const _errs10 = errors;
                  if (typeof data.locale !== "string") {
                    validate52.errors = [{ instancePath: instancePath + "/locale", schemaPath: "#/properties/locale/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                  var valid0 = _errs10 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.message_display_compact !== void 0) {
                    const _errs12 = errors;
                    if (typeof data.message_display_compact !== "boolean") {
                      validate52.errors = [{ instancePath: instancePath + "/message_display_compact", schemaPath: "#/properties/message_display_compact/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                      return false;
                    }
                    var valid0 = _errs12 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.notifications !== void 0) {
                      let data6 = data.notifications;
                      const _errs14 = errors;
                      if (errors === _errs14) {
                        if (data6 && typeof data6 == "object" && !Array.isArray(data6)) {
                        } else {
                          validate52.errors = [{ instancePath: instancePath + "/notifications", schemaPath: "#/properties/notifications/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                          return false;
                        }
                      }
                      var valid0 = _errs14 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.status !== void 0) {
                        const _errs17 = errors;
                        if (typeof data.status !== "string") {
                          validate52.errors = [{ instancePath: instancePath + "/status", schemaPath: "#/properties/status/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                          return false;
                        }
                        var valid0 = _errs17 === errors;
                      } else {
                        var valid0 = true;
                      }
                      if (valid0) {
                        if (data.theme !== void 0) {
                          const _errs19 = errors;
                          if (typeof data.theme !== "string") {
                            validate52.errors = [{ instancePath: instancePath + "/theme", schemaPath: "#/properties/theme/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                            return false;
                          }
                          var valid0 = _errs19 === errors;
                        } else {
                          var valid0 = true;
                        }
                        if (valid0) {
                          if (data.user_id !== void 0) {
                            const _errs21 = errors;
                            if (typeof data.user_id !== "string") {
                              validate52.errors = [{ instancePath: instancePath + "/user_id", schemaPath: "#/properties/user_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                              return false;
                            }
                            var valid0 = _errs21 === errors;
                          } else {
                            var valid0 = true;
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate52.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate52.errors = vErrors;
  return errors === 0;
}
validate52.evaluated = { "props": { "crypto_auth_enabled": true, "custom_css": true, "custom_status": true, "keybinds": true, "locale": true, "message_display_compact": true, "notifications": true, "status": true, "theme": true, "user_id": true }, "dynamicProps": false, "dynamicItems": false };
export {
  isAcceptInviteRequest,
  isChangeEmailRequest,
  isChangePasswordRequest,
  isCreateGuildRequest,
  isCreateInviteRequest,
  isCreateRelationshipRequest,
  isCurrentUser,
  isGuildDetail,
  isGuildEmoji,
  isGuildEmojiList,
  isGuildInvite,
  isGuildInviteList,
  isGuildSummary,
  isGuildSummaryList,
  isInviteAcceptResponse,
  isInvitePreview,
  isOwnershipTransferResponse,
  isPublicUserProfile,
  isReadyGuildCore,
  isRelationshipList,
  isTransferOwnershipRequest,
  isUpdateEmojiRequest,
  isUpdateGuildRequest,
  isUpdateMeRequest,
  isUpdateSettingsRequest,
  isUpdatedCurrentUser,
  isUserSettingsResponse
};
