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

// ../../Paracord-glass/client/node_modules/ajv/dist/runtime/ucs2length.js
var require_ucs2length = __commonJS({
  "../../Paracord-glass/client/node_modules/ajv/dist/runtime/ucs2length.js"(exports) {
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
var isBackupNowResponse = validate21;
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
      if (data.name === void 0 && (missing0 = "name")) {
        validate21.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.name !== void 0) {
          if (typeof data.name !== "string") {
            validate21.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
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
validate21.evaluated = { "props": { "name": true }, "dynamicProps": false, "dynamicItems": false };
var isChangeCredentialRequest = validate22;
var schema33 = { "$defs": { "KdfParams": { "description": 'scrypt parameters as sent on the wire. Stored per credential as\n`"scrypt:<log_n>:<r>:<p>"` (see [`KdfParams::to_db_text`]).', "properties": { "alg": { "description": 'Always `"scrypt"`.', "type": "string" }, "log_n": { "description": "log2 of scrypt's N.", "format": "uint8", "maximum": 255, "minimum": 0, "type": "integer" }, "p": { "format": "uint32", "minimum": 0, "type": "integer" }, "r": { "format": "uint32", "minimum": 0, "type": "integer" } }, "required": ["alg", "log_n", "r", "p"], "type": "object" }, "NewCredential": { "description": "A freshly derived credential: what the server stores in place of a password.", "properties": { "auth_key": { "description": "b64url of the 32-byte HKDF output `paracord/credential/v2/auth`.", "type": "string" }, "kdf": { "$ref": "#/$defs/KdfParams" }, "salt": { "description": "b64url of 32 random bytes.", "type": "string" } }, "required": ["salt", "kdf", "auth_key"], "type": "object" } }, "$id": "urn:paracord:contract:ChangeCredentialRequest", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "`PUT /api/v1/users/@me/credential`: change the password (spec \xA73.7).", "properties": { "credential": { "$ref": "#/$defs/NewCredential" }, "current_auth_key": { "description": "b64url auth key derived from the current password.", "type": "string" }, "mfa_code": { "default": null, "type": ["string", "null"] }, "wrapped_key": { "description": "The same identity, wrapped under the new password's wrap key.", "type": "string" } }, "required": ["current_auth_key", "credential", "wrapped_key"], "title": "ChangeCredentialRequest", "type": "object" };
function validate23(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
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
      if (data.salt === void 0 && (missing0 = "salt") || data.kdf === void 0 && (missing0 = "kdf") || data.auth_key === void 0 && (missing0 = "auth_key")) {
        validate23.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.auth_key !== void 0) {
          const _errs1 = errors;
          if (typeof data.auth_key !== "string") {
            validate23.errors = [{ instancePath: instancePath + "/auth_key", schemaPath: "#/properties/auth_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.kdf !== void 0) {
            let data1 = data.kdf;
            const _errs3 = errors;
            const _errs4 = errors;
            if (errors === _errs4) {
              if (data1 && typeof data1 == "object" && !Array.isArray(data1)) {
                let missing1;
                if (data1.alg === void 0 && (missing1 = "alg") || data1.log_n === void 0 && (missing1 = "log_n") || data1.r === void 0 && (missing1 = "r") || data1.p === void 0 && (missing1 = "p")) {
                  validate23.errors = [{ instancePath: instancePath + "/kdf", schemaPath: "#/$defs/KdfParams/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                  return false;
                } else {
                  if (data1.alg !== void 0) {
                    const _errs6 = errors;
                    if (typeof data1.alg !== "string") {
                      validate23.errors = [{ instancePath: instancePath + "/kdf/alg", schemaPath: "#/$defs/KdfParams/properties/alg/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid2 = _errs6 === errors;
                  } else {
                    var valid2 = true;
                  }
                  if (valid2) {
                    if (data1.log_n !== void 0) {
                      let data3 = data1.log_n;
                      const _errs8 = errors;
                      if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3))) {
                        validate23.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      if (errors === _errs8) {
                        if (typeof data3 == "number" && isFinite(data3)) {
                          if (data3 > 255 || isNaN(data3)) {
                            validate23.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/maximum", keyword: "maximum", params: { comparison: "<=", limit: 255 }, message: "must be <= 255" }];
                            return false;
                          } else {
                            if (data3 < 0 || isNaN(data3)) {
                              validate23.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                              return false;
                            }
                          }
                        }
                      }
                      var valid2 = _errs8 === errors;
                    } else {
                      var valid2 = true;
                    }
                    if (valid2) {
                      if (data1.p !== void 0) {
                        let data4 = data1.p;
                        const _errs10 = errors;
                        if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
                          validate23.errors = [{ instancePath: instancePath + "/kdf/p", schemaPath: "#/$defs/KdfParams/properties/p/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                          return false;
                        }
                        if (errors === _errs10) {
                          if (typeof data4 == "number" && isFinite(data4)) {
                            if (data4 < 0 || isNaN(data4)) {
                              validate23.errors = [{ instancePath: instancePath + "/kdf/p", schemaPath: "#/$defs/KdfParams/properties/p/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                              return false;
                            }
                          }
                        }
                        var valid2 = _errs10 === errors;
                      } else {
                        var valid2 = true;
                      }
                      if (valid2) {
                        if (data1.r !== void 0) {
                          let data5 = data1.r;
                          const _errs12 = errors;
                          if (!(typeof data5 == "number" && (!(data5 % 1) && !isNaN(data5)) && isFinite(data5))) {
                            validate23.errors = [{ instancePath: instancePath + "/kdf/r", schemaPath: "#/$defs/KdfParams/properties/r/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                            return false;
                          }
                          if (errors === _errs12) {
                            if (typeof data5 == "number" && isFinite(data5)) {
                              if (data5 < 0 || isNaN(data5)) {
                                validate23.errors = [{ instancePath: instancePath + "/kdf/r", schemaPath: "#/$defs/KdfParams/properties/r/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                return false;
                              }
                            }
                          }
                          var valid2 = _errs12 === errors;
                        } else {
                          var valid2 = true;
                        }
                      }
                    }
                  }
                }
              } else {
                validate23.errors = [{ instancePath: instancePath + "/kdf", schemaPath: "#/$defs/KdfParams/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                return false;
              }
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.salt !== void 0) {
              const _errs14 = errors;
              if (typeof data.salt !== "string") {
                validate23.errors = [{ instancePath: instancePath + "/salt", schemaPath: "#/properties/salt/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              var valid0 = _errs14 === errors;
            } else {
              var valid0 = true;
            }
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
validate23.evaluated = { "props": { "auth_key": true, "kdf": true, "salt": true }, "dynamicProps": false, "dynamicItems": false };
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
      if (data.current_auth_key === void 0 && (missing0 = "current_auth_key") || data.credential === void 0 && (missing0 = "credential") || data.wrapped_key === void 0 && (missing0 = "wrapped_key")) {
        validate22.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.credential !== void 0) {
          const _errs1 = errors;
          if (!validate23(data.credential, { instancePath: instancePath + "/credential", parentData: data, parentDataProperty: "credential", rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate23.errors : vErrors.concat(validate23.errors);
            errors = vErrors.length;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.current_auth_key !== void 0) {
            const _errs2 = errors;
            if (typeof data.current_auth_key !== "string") {
              validate22.errors = [{ instancePath: instancePath + "/current_auth_key", schemaPath: "#/properties/current_auth_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs2 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.mfa_code !== void 0) {
              let data2 = data.mfa_code;
              const _errs4 = errors;
              if (typeof data2 !== "string" && data2 !== null) {
                validate22.errors = [{ instancePath: instancePath + "/mfa_code", schemaPath: "#/properties/mfa_code/type", keyword: "type", params: { type: schema33.properties.mfa_code.type }, message: "must be string,null" }];
                return false;
              }
              var valid0 = _errs4 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.wrapped_key !== void 0) {
                const _errs6 = errors;
                if (typeof data.wrapped_key !== "string") {
                  validate22.errors = [{ instancePath: instancePath + "/wrapped_key", schemaPath: "#/properties/wrapped_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid0 = _errs6 === errors;
              } else {
                var valid0 = true;
              }
            }
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
validate22.evaluated = { "props": { "credential": true, "current_auth_key": true, "mfa_code": true, "wrapped_key": true }, "dynamicProps": false, "dynamicItems": false };
var isChangeEmailRequest = validate25;
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
      let missing0;
      if (data.current_password === void 0 && (missing0 = "current_password") || data.new_email === void 0 && (missing0 = "new_email")) {
        validate25.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.current_password !== void 0) {
          const _errs1 = errors;
          if (typeof data.current_password !== "string") {
            validate25.errors = [{ instancePath: instancePath + "/current_password", schemaPath: "#/properties/current_password/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
              validate25.errors = [{ instancePath: instancePath + "/new_email", schemaPath: "#/properties/new_email/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs3 === errors;
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
validate25.evaluated = { "props": { "current_password": true, "new_email": true }, "dynamicProps": false, "dynamicItems": false };
var isChangePasswordRequest = validate26;
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
      if (data.current_password === void 0 && (missing0 = "current_password") || data.new_password === void 0 && (missing0 = "new_password")) {
        validate26.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.current_password !== void 0) {
          const _errs1 = errors;
          if (typeof data.current_password !== "string") {
            validate26.errors = [{ instancePath: instancePath + "/current_password", schemaPath: "#/properties/current_password/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
              validate26.errors = [{ instancePath: instancePath + "/new_password", schemaPath: "#/properties/new_password/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
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
validate26.evaluated = { "props": { "current_password": true, "new_password": true }, "dynamicProps": false, "dynamicItems": false };
var isChannelPreview = validate27;
var schema38 = { "$defs": { "ChannelPreviewAuthorKind": { "description": "Who a preview's message reads as. `author_id` means a different thing for\neach: a user id, a webhook id, a feed id, or (for an anonymous message the\nviewer may not unmask) the `anon:{channel_id}:{alias}` pseudo-id that the\nmessage itself carries. Only `user` ids name a member.", "enum": ["user", "webhook", "feed", "anonymous"], "type": "string" }, "ChannelPreviewMedia": { "description": "The first attachment of a preview's message, so a row can lead with a\nthumbnail. The client builds the file URL from `attachment_id`.", "properties": { "attachment_id": { "minLength": 1, "pattern": "^[0-9]+$", "type": "string" }, "content_type": { "type": ["string", "null"] }, "filename": { "type": "string" }, "height": { "format": "int32", "maximum": 2147483647, "minimum": -2147483648, "type": ["integer", "null"] }, "width": { "format": "int32", "maximum": 2147483647, "minimum": -2147483648, "type": ["integer", "null"] } }, "required": ["attachment_id", "content_type", "filename", "width", "height"], "type": "object" } }, "$id": "urn:paracord:contract:ChannelPreview", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "The newest message of one guild channel, for the channel row of the\nplaces panel (`GET /api/v1/guilds/{guild_id}/channel-previews`).\n\n`content` is the message's raw text (markdown and `<@id>` tokens intact)\nwith whitespace runs collapsed to single spaces, cut to at most 140\ncharacters including a trailing `\u2026` when `truncated`; a cut never ends\ninside a `<\u2026>` token. Rendering (mentions, spoilers, emphasis) is the\nclient's job. It is null for an encrypted message, whose body the server\ncannot read, and for a message without text (only media or a sticker).\nA poll's text is its question (`message_type` 20).\n`media` is null for an encrypted message as well.", "properties": { "attachment_count": { "format": "uint32", "maximum": 4294967295, "minimum": 0, "type": "integer" }, "author_id": { "minLength": 1, "type": "string" }, "author_kind": { "$ref": "#/$defs/ChannelPreviewAuthorKind" }, "author_name": { "description": "Guild nickname, else display name, else username; the webhook, feed or\nanonymous alias for those kinds. Null when the author record is gone.", "type": ["string", "null"] }, "channel_id": { "minLength": 1, "pattern": "^[0-9]+$", "type": "string" }, "content": { "type": ["string", "null"] }, "created_at": { "minLength": 1, "type": "string" }, "encrypted": { "type": "boolean" }, "has_sticker": { "type": "boolean" }, "media": { "anyOf": [{ "$ref": "#/$defs/ChannelPreviewMedia" }, { "type": "null" }] }, "message_id": { "minLength": 1, "pattern": "^[0-9]+$", "type": "string" }, "message_type": { "format": "int32", "maximum": 2147483647, "minimum": -2147483648, "type": "integer" }, "truncated": { "type": "boolean" } }, "required": ["channel_id", "message_id", "message_type", "author_id", "author_kind", "author_name", "content", "truncated", "encrypted", "created_at", "media", "attachment_count", "has_sticker"], "title": "ChannelPreview", "type": "object" };
var schema39 = { "description": "Who a preview's message reads as. `author_id` means a different thing for\neach: a user id, a webhook id, a feed id, or (for an anonymous message the\nviewer may not unmask) the `anon:{channel_id}:{alias}` pseudo-id that the\nmessage itself carries. Only `user` ids name a member.", "enum": ["user", "webhook", "feed", "anonymous"], "type": "string" };
var schema40 = { "description": "The first attachment of a preview's message, so a row can lead with a\nthumbnail. The client builds the file URL from `attachment_id`.", "properties": { "attachment_id": { "minLength": 1, "pattern": "^[0-9]+$", "type": "string" }, "content_type": { "type": ["string", "null"] }, "filename": { "type": "string" }, "height": { "format": "int32", "maximum": 2147483647, "minimum": -2147483648, "type": ["integer", "null"] }, "width": { "format": "int32", "maximum": 2147483647, "minimum": -2147483648, "type": ["integer", "null"] } }, "required": ["attachment_id", "content_type", "filename", "width", "height"], "type": "object" };
var func1 = require_ucs2length().default;
var pattern4 = new RegExp("^[0-9]+$", "u");
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
      if (data.channel_id === void 0 && (missing0 = "channel_id") || data.message_id === void 0 && (missing0 = "message_id") || data.message_type === void 0 && (missing0 = "message_type") || data.author_id === void 0 && (missing0 = "author_id") || data.author_kind === void 0 && (missing0 = "author_kind") || data.author_name === void 0 && (missing0 = "author_name") || data.content === void 0 && (missing0 = "content") || data.truncated === void 0 && (missing0 = "truncated") || data.encrypted === void 0 && (missing0 = "encrypted") || data.created_at === void 0 && (missing0 = "created_at") || data.media === void 0 && (missing0 = "media") || data.attachment_count === void 0 && (missing0 = "attachment_count") || data.has_sticker === void 0 && (missing0 = "has_sticker")) {
        validate27.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.attachment_count !== void 0) {
          let data0 = data.attachment_count;
          const _errs1 = errors;
          if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)) && isFinite(data0))) {
            validate27.errors = [{ instancePath: instancePath + "/attachment_count", schemaPath: "#/properties/attachment_count/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
            return false;
          }
          if (errors === _errs1) {
            if (typeof data0 == "number" && isFinite(data0)) {
              if (data0 > 4294967295 || isNaN(data0)) {
                validate27.errors = [{ instancePath: instancePath + "/attachment_count", schemaPath: "#/properties/attachment_count/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" }];
                return false;
              } else {
                if (data0 < 0 || isNaN(data0)) {
                  validate27.errors = [{ instancePath: instancePath + "/attachment_count", schemaPath: "#/properties/attachment_count/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                  return false;
                }
              }
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.author_id !== void 0) {
            let data1 = data.author_id;
            const _errs3 = errors;
            if (errors === _errs3) {
              if (typeof data1 === "string") {
                if (func1(data1) < 1) {
                  validate27.errors = [{ instancePath: instancePath + "/author_id", schemaPath: "#/properties/author_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                }
              } else {
                validate27.errors = [{ instancePath: instancePath + "/author_id", schemaPath: "#/properties/author_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.author_kind !== void 0) {
              let data2 = data.author_kind;
              const _errs5 = errors;
              if (typeof data2 !== "string") {
                validate27.errors = [{ instancePath: instancePath + "/author_kind", schemaPath: "#/$defs/ChannelPreviewAuthorKind/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              if (!(data2 === "user" || data2 === "webhook" || data2 === "feed" || data2 === "anonymous")) {
                validate27.errors = [{ instancePath: instancePath + "/author_kind", schemaPath: "#/$defs/ChannelPreviewAuthorKind/enum", keyword: "enum", params: { allowedValues: schema39.enum }, message: "must be equal to one of the allowed values" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.author_name !== void 0) {
                let data3 = data.author_name;
                const _errs8 = errors;
                if (typeof data3 !== "string" && data3 !== null) {
                  validate27.errors = [{ instancePath: instancePath + "/author_name", schemaPath: "#/properties/author_name/type", keyword: "type", params: { type: schema38.properties.author_name.type }, message: "must be string,null" }];
                  return false;
                }
                var valid0 = _errs8 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.channel_id !== void 0) {
                  let data4 = data.channel_id;
                  const _errs10 = errors;
                  if (errors === _errs10) {
                    if (typeof data4 === "string") {
                      if (func1(data4) < 1) {
                        validate27.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                        return false;
                      } else {
                        if (!pattern4.test(data4)) {
                          validate27.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/pattern", keyword: "pattern", params: { pattern: "^[0-9]+$" }, message: 'must match pattern "^[0-9]+$"' }];
                          return false;
                        }
                      }
                    } else {
                      validate27.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                  }
                  var valid0 = _errs10 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.content !== void 0) {
                    let data5 = data.content;
                    const _errs12 = errors;
                    if (typeof data5 !== "string" && data5 !== null) {
                      validate27.errors = [{ instancePath: instancePath + "/content", schemaPath: "#/properties/content/type", keyword: "type", params: { type: schema38.properties.content.type }, message: "must be string,null" }];
                      return false;
                    }
                    var valid0 = _errs12 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.created_at !== void 0) {
                      let data6 = data.created_at;
                      const _errs14 = errors;
                      if (errors === _errs14) {
                        if (typeof data6 === "string") {
                          if (func1(data6) < 1) {
                            validate27.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                            return false;
                          }
                        } else {
                          validate27.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                          return false;
                        }
                      }
                      var valid0 = _errs14 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.encrypted !== void 0) {
                        const _errs16 = errors;
                        if (typeof data.encrypted !== "boolean") {
                          validate27.errors = [{ instancePath: instancePath + "/encrypted", schemaPath: "#/properties/encrypted/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                          return false;
                        }
                        var valid0 = _errs16 === errors;
                      } else {
                        var valid0 = true;
                      }
                      if (valid0) {
                        if (data.has_sticker !== void 0) {
                          const _errs18 = errors;
                          if (typeof data.has_sticker !== "boolean") {
                            validate27.errors = [{ instancePath: instancePath + "/has_sticker", schemaPath: "#/properties/has_sticker/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                            return false;
                          }
                          var valid0 = _errs18 === errors;
                        } else {
                          var valid0 = true;
                        }
                        if (valid0) {
                          if (data.media !== void 0) {
                            let data9 = data.media;
                            const _errs20 = errors;
                            const _errs21 = errors;
                            let valid2 = false;
                            const _errs22 = errors;
                            const _errs23 = errors;
                            if (errors === _errs23) {
                              if (data9 && typeof data9 == "object" && !Array.isArray(data9)) {
                                let missing1;
                                if (data9.attachment_id === void 0 && (missing1 = "attachment_id") || data9.content_type === void 0 && (missing1 = "content_type") || data9.filename === void 0 && (missing1 = "filename") || data9.width === void 0 && (missing1 = "width") || data9.height === void 0 && (missing1 = "height")) {
                                  const err0 = { instancePath: instancePath + "/media", schemaPath: "#/$defs/ChannelPreviewMedia/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" };
                                  if (vErrors === null) {
                                    vErrors = [err0];
                                  } else {
                                    vErrors.push(err0);
                                  }
                                  errors++;
                                } else {
                                  if (data9.attachment_id !== void 0) {
                                    let data10 = data9.attachment_id;
                                    const _errs25 = errors;
                                    if (errors === _errs25) {
                                      if (typeof data10 === "string") {
                                        if (func1(data10) < 1) {
                                          const err1 = { instancePath: instancePath + "/media/attachment_id", schemaPath: "#/$defs/ChannelPreviewMedia/properties/attachment_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                                          if (vErrors === null) {
                                            vErrors = [err1];
                                          } else {
                                            vErrors.push(err1);
                                          }
                                          errors++;
                                        } else {
                                          if (!pattern4.test(data10)) {
                                            const err2 = { instancePath: instancePath + "/media/attachment_id", schemaPath: "#/$defs/ChannelPreviewMedia/properties/attachment_id/pattern", keyword: "pattern", params: { pattern: "^[0-9]+$" }, message: 'must match pattern "^[0-9]+$"' };
                                            if (vErrors === null) {
                                              vErrors = [err2];
                                            } else {
                                              vErrors.push(err2);
                                            }
                                            errors++;
                                          }
                                        }
                                      } else {
                                        const err3 = { instancePath: instancePath + "/media/attachment_id", schemaPath: "#/$defs/ChannelPreviewMedia/properties/attachment_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                        if (vErrors === null) {
                                          vErrors = [err3];
                                        } else {
                                          vErrors.push(err3);
                                        }
                                        errors++;
                                      }
                                    }
                                    var valid4 = _errs25 === errors;
                                  } else {
                                    var valid4 = true;
                                  }
                                  if (valid4) {
                                    if (data9.content_type !== void 0) {
                                      let data11 = data9.content_type;
                                      const _errs27 = errors;
                                      if (typeof data11 !== "string" && data11 !== null) {
                                        const err4 = { instancePath: instancePath + "/media/content_type", schemaPath: "#/$defs/ChannelPreviewMedia/properties/content_type/type", keyword: "type", params: { type: schema40.properties.content_type.type }, message: "must be string,null" };
                                        if (vErrors === null) {
                                          vErrors = [err4];
                                        } else {
                                          vErrors.push(err4);
                                        }
                                        errors++;
                                      }
                                      var valid4 = _errs27 === errors;
                                    } else {
                                      var valid4 = true;
                                    }
                                    if (valid4) {
                                      if (data9.filename !== void 0) {
                                        const _errs29 = errors;
                                        if (typeof data9.filename !== "string") {
                                          const err5 = { instancePath: instancePath + "/media/filename", schemaPath: "#/$defs/ChannelPreviewMedia/properties/filename/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                          if (vErrors === null) {
                                            vErrors = [err5];
                                          } else {
                                            vErrors.push(err5);
                                          }
                                          errors++;
                                        }
                                        var valid4 = _errs29 === errors;
                                      } else {
                                        var valid4 = true;
                                      }
                                      if (valid4) {
                                        if (data9.height !== void 0) {
                                          let data13 = data9.height;
                                          const _errs31 = errors;
                                          if (!(typeof data13 == "number" && (!(data13 % 1) && !isNaN(data13)) && isFinite(data13)) && data13 !== null) {
                                            const err6 = { instancePath: instancePath + "/media/height", schemaPath: "#/$defs/ChannelPreviewMedia/properties/height/type", keyword: "type", params: { type: schema40.properties.height.type }, message: "must be integer,null" };
                                            if (vErrors === null) {
                                              vErrors = [err6];
                                            } else {
                                              vErrors.push(err6);
                                            }
                                            errors++;
                                          }
                                          if (errors === _errs31) {
                                            if (typeof data13 == "number" && isFinite(data13)) {
                                              if (data13 > 2147483647 || isNaN(data13)) {
                                                const err7 = { instancePath: instancePath + "/media/height", schemaPath: "#/$defs/ChannelPreviewMedia/properties/height/maximum", keyword: "maximum", params: { comparison: "<=", limit: 2147483647 }, message: "must be <= 2147483647" };
                                                if (vErrors === null) {
                                                  vErrors = [err7];
                                                } else {
                                                  vErrors.push(err7);
                                                }
                                                errors++;
                                              } else {
                                                if (data13 < -2147483648 || isNaN(data13)) {
                                                  const err8 = { instancePath: instancePath + "/media/height", schemaPath: "#/$defs/ChannelPreviewMedia/properties/height/minimum", keyword: "minimum", params: { comparison: ">=", limit: -2147483648 }, message: "must be >= -2147483648" };
                                                  if (vErrors === null) {
                                                    vErrors = [err8];
                                                  } else {
                                                    vErrors.push(err8);
                                                  }
                                                  errors++;
                                                }
                                              }
                                            }
                                          }
                                          var valid4 = _errs31 === errors;
                                        } else {
                                          var valid4 = true;
                                        }
                                        if (valid4) {
                                          if (data9.width !== void 0) {
                                            let data14 = data9.width;
                                            const _errs33 = errors;
                                            if (!(typeof data14 == "number" && (!(data14 % 1) && !isNaN(data14)) && isFinite(data14)) && data14 !== null) {
                                              const err9 = { instancePath: instancePath + "/media/width", schemaPath: "#/$defs/ChannelPreviewMedia/properties/width/type", keyword: "type", params: { type: schema40.properties.width.type }, message: "must be integer,null" };
                                              if (vErrors === null) {
                                                vErrors = [err9];
                                              } else {
                                                vErrors.push(err9);
                                              }
                                              errors++;
                                            }
                                            if (errors === _errs33) {
                                              if (typeof data14 == "number" && isFinite(data14)) {
                                                if (data14 > 2147483647 || isNaN(data14)) {
                                                  const err10 = { instancePath: instancePath + "/media/width", schemaPath: "#/$defs/ChannelPreviewMedia/properties/width/maximum", keyword: "maximum", params: { comparison: "<=", limit: 2147483647 }, message: "must be <= 2147483647" };
                                                  if (vErrors === null) {
                                                    vErrors = [err10];
                                                  } else {
                                                    vErrors.push(err10);
                                                  }
                                                  errors++;
                                                } else {
                                                  if (data14 < -2147483648 || isNaN(data14)) {
                                                    const err11 = { instancePath: instancePath + "/media/width", schemaPath: "#/$defs/ChannelPreviewMedia/properties/width/minimum", keyword: "minimum", params: { comparison: ">=", limit: -2147483648 }, message: "must be >= -2147483648" };
                                                    if (vErrors === null) {
                                                      vErrors = [err11];
                                                    } else {
                                                      vErrors.push(err11);
                                                    }
                                                    errors++;
                                                  }
                                                }
                                              }
                                            }
                                            var valid4 = _errs33 === errors;
                                          } else {
                                            var valid4 = true;
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              } else {
                                const err12 = { instancePath: instancePath + "/media", schemaPath: "#/$defs/ChannelPreviewMedia/type", keyword: "type", params: { type: "object" }, message: "must be object" };
                                if (vErrors === null) {
                                  vErrors = [err12];
                                } else {
                                  vErrors.push(err12);
                                }
                                errors++;
                              }
                            }
                            var _valid0 = _errs22 === errors;
                            valid2 = valid2 || _valid0;
                            if (_valid0) {
                              var props0 = {};
                              props0.attachment_id = true;
                              props0.content_type = true;
                              props0.filename = true;
                              props0.height = true;
                              props0.width = true;
                            }
                            const _errs35 = errors;
                            if (data9 !== null) {
                              const err13 = { instancePath: instancePath + "/media", schemaPath: "#/properties/media/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                              if (vErrors === null) {
                                vErrors = [err13];
                              } else {
                                vErrors.push(err13);
                              }
                              errors++;
                            }
                            var _valid0 = _errs35 === errors;
                            valid2 = valid2 || _valid0;
                            if (!valid2) {
                              const err14 = { instancePath: instancePath + "/media", schemaPath: "#/properties/media/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                              if (vErrors === null) {
                                vErrors = [err14];
                              } else {
                                vErrors.push(err14);
                              }
                              errors++;
                              validate27.errors = vErrors;
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
                            if (data.message_id !== void 0) {
                              let data15 = data.message_id;
                              const _errs37 = errors;
                              if (errors === _errs37) {
                                if (typeof data15 === "string") {
                                  if (func1(data15) < 1) {
                                    validate27.errors = [{ instancePath: instancePath + "/message_id", schemaPath: "#/properties/message_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                                    return false;
                                  } else {
                                    if (!pattern4.test(data15)) {
                                      validate27.errors = [{ instancePath: instancePath + "/message_id", schemaPath: "#/properties/message_id/pattern", keyword: "pattern", params: { pattern: "^[0-9]+$" }, message: 'must match pattern "^[0-9]+$"' }];
                                      return false;
                                    }
                                  }
                                } else {
                                  validate27.errors = [{ instancePath: instancePath + "/message_id", schemaPath: "#/properties/message_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                  return false;
                                }
                              }
                              var valid0 = _errs37 === errors;
                            } else {
                              var valid0 = true;
                            }
                            if (valid0) {
                              if (data.message_type !== void 0) {
                                let data16 = data.message_type;
                                const _errs39 = errors;
                                if (!(typeof data16 == "number" && (!(data16 % 1) && !isNaN(data16)) && isFinite(data16))) {
                                  validate27.errors = [{ instancePath: instancePath + "/message_type", schemaPath: "#/properties/message_type/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                                  return false;
                                }
                                if (errors === _errs39) {
                                  if (typeof data16 == "number" && isFinite(data16)) {
                                    if (data16 > 2147483647 || isNaN(data16)) {
                                      validate27.errors = [{ instancePath: instancePath + "/message_type", schemaPath: "#/properties/message_type/maximum", keyword: "maximum", params: { comparison: "<=", limit: 2147483647 }, message: "must be <= 2147483647" }];
                                      return false;
                                    } else {
                                      if (data16 < -2147483648 || isNaN(data16)) {
                                        validate27.errors = [{ instancePath: instancePath + "/message_type", schemaPath: "#/properties/message_type/minimum", keyword: "minimum", params: { comparison: ">=", limit: -2147483648 }, message: "must be >= -2147483648" }];
                                        return false;
                                      }
                                    }
                                  }
                                }
                                var valid0 = _errs39 === errors;
                              } else {
                                var valid0 = true;
                              }
                              if (valid0) {
                                if (data.truncated !== void 0) {
                                  const _errs41 = errors;
                                  if (typeof data.truncated !== "boolean") {
                                    validate27.errors = [{ instancePath: instancePath + "/truncated", schemaPath: "#/properties/truncated/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                                    return false;
                                  }
                                  var valid0 = _errs41 === errors;
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
      validate27.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate27.errors = vErrors;
  return errors === 0;
}
validate27.evaluated = { "props": { "attachment_count": true, "author_id": true, "author_kind": true, "author_name": true, "channel_id": true, "content": true, "created_at": true, "encrypted": true, "has_sticker": true, "media": true, "message_id": true, "message_type": true, "truncated": true }, "dynamicProps": false, "dynamicItems": false };
var isChannelPreviewList = validate28;
var schema42 = { "description": "The newest message of one guild channel, for the channel row of the\nplaces panel (`GET /api/v1/guilds/{guild_id}/channel-previews`).\n\n`content` is the message's raw text (markdown and `<@id>` tokens intact)\nwith whitespace runs collapsed to single spaces, cut to at most 140\ncharacters including a trailing `\u2026` when `truncated`; a cut never ends\ninside a `<\u2026>` token. Rendering (mentions, spoilers, emphasis) is the\nclient's job. It is null for an encrypted message, whose body the server\ncannot read, and for a message without text (only media or a sticker).\nA poll's text is its question (`message_type` 20).\n`media` is null for an encrypted message as well.", "properties": { "attachment_count": { "format": "uint32", "maximum": 4294967295, "minimum": 0, "type": "integer" }, "author_id": { "minLength": 1, "type": "string" }, "author_kind": { "$ref": "#/$defs/ChannelPreviewAuthorKind" }, "author_name": { "description": "Guild nickname, else display name, else username; the webhook, feed or\nanonymous alias for those kinds. Null when the author record is gone.", "type": ["string", "null"] }, "channel_id": { "minLength": 1, "pattern": "^[0-9]+$", "type": "string" }, "content": { "type": ["string", "null"] }, "created_at": { "minLength": 1, "type": "string" }, "encrypted": { "type": "boolean" }, "has_sticker": { "type": "boolean" }, "media": { "anyOf": [{ "$ref": "#/$defs/ChannelPreviewMedia" }, { "type": "null" }] }, "message_id": { "minLength": 1, "pattern": "^[0-9]+$", "type": "string" }, "message_type": { "format": "int32", "maximum": 2147483647, "minimum": -2147483648, "type": "integer" }, "truncated": { "type": "boolean" } }, "required": ["channel_id", "message_id", "message_type", "author_id", "author_kind", "author_name", "content", "truncated", "encrypted", "created_at", "media", "attachment_count", "has_sticker"], "type": "object" };
var schema43 = { "description": "Who a preview's message reads as. `author_id` means a different thing for\neach: a user id, a webhook id, a feed id, or (for an anonymous message the\nviewer may not unmask) the `anon:{channel_id}:{alias}` pseudo-id that the\nmessage itself carries. Only `user` ids name a member.", "enum": ["user", "webhook", "feed", "anonymous"], "type": "string" };
var schema44 = { "description": "The first attachment of a preview's message, so a row can lead with a\nthumbnail. The client builds the file URL from `attachment_id`.", "properties": { "attachment_id": { "minLength": 1, "pattern": "^[0-9]+$", "type": "string" }, "content_type": { "type": ["string", "null"] }, "filename": { "type": "string" }, "height": { "format": "int32", "maximum": 2147483647, "minimum": -2147483648, "type": ["integer", "null"] }, "width": { "format": "int32", "maximum": 2147483647, "minimum": -2147483648, "type": ["integer", "null"] } }, "required": ["attachment_id", "content_type", "filename", "width", "height"], "type": "object" };
function validate29(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
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
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.channel_id === void 0 && (missing0 = "channel_id") || data.message_id === void 0 && (missing0 = "message_id") || data.message_type === void 0 && (missing0 = "message_type") || data.author_id === void 0 && (missing0 = "author_id") || data.author_kind === void 0 && (missing0 = "author_kind") || data.author_name === void 0 && (missing0 = "author_name") || data.content === void 0 && (missing0 = "content") || data.truncated === void 0 && (missing0 = "truncated") || data.encrypted === void 0 && (missing0 = "encrypted") || data.created_at === void 0 && (missing0 = "created_at") || data.media === void 0 && (missing0 = "media") || data.attachment_count === void 0 && (missing0 = "attachment_count") || data.has_sticker === void 0 && (missing0 = "has_sticker")) {
        validate29.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.attachment_count !== void 0) {
          let data0 = data.attachment_count;
          const _errs1 = errors;
          if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)) && isFinite(data0))) {
            validate29.errors = [{ instancePath: instancePath + "/attachment_count", schemaPath: "#/properties/attachment_count/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
            return false;
          }
          if (errors === _errs1) {
            if (typeof data0 == "number" && isFinite(data0)) {
              if (data0 > 4294967295 || isNaN(data0)) {
                validate29.errors = [{ instancePath: instancePath + "/attachment_count", schemaPath: "#/properties/attachment_count/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" }];
                return false;
              } else {
                if (data0 < 0 || isNaN(data0)) {
                  validate29.errors = [{ instancePath: instancePath + "/attachment_count", schemaPath: "#/properties/attachment_count/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                  return false;
                }
              }
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.author_id !== void 0) {
            let data1 = data.author_id;
            const _errs3 = errors;
            if (errors === _errs3) {
              if (typeof data1 === "string") {
                if (func1(data1) < 1) {
                  validate29.errors = [{ instancePath: instancePath + "/author_id", schemaPath: "#/properties/author_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                }
              } else {
                validate29.errors = [{ instancePath: instancePath + "/author_id", schemaPath: "#/properties/author_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.author_kind !== void 0) {
              let data2 = data.author_kind;
              const _errs5 = errors;
              if (typeof data2 !== "string") {
                validate29.errors = [{ instancePath: instancePath + "/author_kind", schemaPath: "#/$defs/ChannelPreviewAuthorKind/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              if (!(data2 === "user" || data2 === "webhook" || data2 === "feed" || data2 === "anonymous")) {
                validate29.errors = [{ instancePath: instancePath + "/author_kind", schemaPath: "#/$defs/ChannelPreviewAuthorKind/enum", keyword: "enum", params: { allowedValues: schema43.enum }, message: "must be equal to one of the allowed values" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.author_name !== void 0) {
                let data3 = data.author_name;
                const _errs8 = errors;
                if (typeof data3 !== "string" && data3 !== null) {
                  validate29.errors = [{ instancePath: instancePath + "/author_name", schemaPath: "#/properties/author_name/type", keyword: "type", params: { type: schema42.properties.author_name.type }, message: "must be string,null" }];
                  return false;
                }
                var valid0 = _errs8 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.channel_id !== void 0) {
                  let data4 = data.channel_id;
                  const _errs10 = errors;
                  if (errors === _errs10) {
                    if (typeof data4 === "string") {
                      if (func1(data4) < 1) {
                        validate29.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                        return false;
                      } else {
                        if (!pattern4.test(data4)) {
                          validate29.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/pattern", keyword: "pattern", params: { pattern: "^[0-9]+$" }, message: 'must match pattern "^[0-9]+$"' }];
                          return false;
                        }
                      }
                    } else {
                      validate29.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                  }
                  var valid0 = _errs10 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.content !== void 0) {
                    let data5 = data.content;
                    const _errs12 = errors;
                    if (typeof data5 !== "string" && data5 !== null) {
                      validate29.errors = [{ instancePath: instancePath + "/content", schemaPath: "#/properties/content/type", keyword: "type", params: { type: schema42.properties.content.type }, message: "must be string,null" }];
                      return false;
                    }
                    var valid0 = _errs12 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.created_at !== void 0) {
                      let data6 = data.created_at;
                      const _errs14 = errors;
                      if (errors === _errs14) {
                        if (typeof data6 === "string") {
                          if (func1(data6) < 1) {
                            validate29.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                            return false;
                          }
                        } else {
                          validate29.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                          return false;
                        }
                      }
                      var valid0 = _errs14 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.encrypted !== void 0) {
                        const _errs16 = errors;
                        if (typeof data.encrypted !== "boolean") {
                          validate29.errors = [{ instancePath: instancePath + "/encrypted", schemaPath: "#/properties/encrypted/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                          return false;
                        }
                        var valid0 = _errs16 === errors;
                      } else {
                        var valid0 = true;
                      }
                      if (valid0) {
                        if (data.has_sticker !== void 0) {
                          const _errs18 = errors;
                          if (typeof data.has_sticker !== "boolean") {
                            validate29.errors = [{ instancePath: instancePath + "/has_sticker", schemaPath: "#/properties/has_sticker/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                            return false;
                          }
                          var valid0 = _errs18 === errors;
                        } else {
                          var valid0 = true;
                        }
                        if (valid0) {
                          if (data.media !== void 0) {
                            let data9 = data.media;
                            const _errs20 = errors;
                            const _errs21 = errors;
                            let valid2 = false;
                            const _errs22 = errors;
                            const _errs23 = errors;
                            if (errors === _errs23) {
                              if (data9 && typeof data9 == "object" && !Array.isArray(data9)) {
                                let missing1;
                                if (data9.attachment_id === void 0 && (missing1 = "attachment_id") || data9.content_type === void 0 && (missing1 = "content_type") || data9.filename === void 0 && (missing1 = "filename") || data9.width === void 0 && (missing1 = "width") || data9.height === void 0 && (missing1 = "height")) {
                                  const err0 = { instancePath: instancePath + "/media", schemaPath: "#/$defs/ChannelPreviewMedia/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" };
                                  if (vErrors === null) {
                                    vErrors = [err0];
                                  } else {
                                    vErrors.push(err0);
                                  }
                                  errors++;
                                } else {
                                  if (data9.attachment_id !== void 0) {
                                    let data10 = data9.attachment_id;
                                    const _errs25 = errors;
                                    if (errors === _errs25) {
                                      if (typeof data10 === "string") {
                                        if (func1(data10) < 1) {
                                          const err1 = { instancePath: instancePath + "/media/attachment_id", schemaPath: "#/$defs/ChannelPreviewMedia/properties/attachment_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                                          if (vErrors === null) {
                                            vErrors = [err1];
                                          } else {
                                            vErrors.push(err1);
                                          }
                                          errors++;
                                        } else {
                                          if (!pattern4.test(data10)) {
                                            const err2 = { instancePath: instancePath + "/media/attachment_id", schemaPath: "#/$defs/ChannelPreviewMedia/properties/attachment_id/pattern", keyword: "pattern", params: { pattern: "^[0-9]+$" }, message: 'must match pattern "^[0-9]+$"' };
                                            if (vErrors === null) {
                                              vErrors = [err2];
                                            } else {
                                              vErrors.push(err2);
                                            }
                                            errors++;
                                          }
                                        }
                                      } else {
                                        const err3 = { instancePath: instancePath + "/media/attachment_id", schemaPath: "#/$defs/ChannelPreviewMedia/properties/attachment_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                        if (vErrors === null) {
                                          vErrors = [err3];
                                        } else {
                                          vErrors.push(err3);
                                        }
                                        errors++;
                                      }
                                    }
                                    var valid4 = _errs25 === errors;
                                  } else {
                                    var valid4 = true;
                                  }
                                  if (valid4) {
                                    if (data9.content_type !== void 0) {
                                      let data11 = data9.content_type;
                                      const _errs27 = errors;
                                      if (typeof data11 !== "string" && data11 !== null) {
                                        const err4 = { instancePath: instancePath + "/media/content_type", schemaPath: "#/$defs/ChannelPreviewMedia/properties/content_type/type", keyword: "type", params: { type: schema44.properties.content_type.type }, message: "must be string,null" };
                                        if (vErrors === null) {
                                          vErrors = [err4];
                                        } else {
                                          vErrors.push(err4);
                                        }
                                        errors++;
                                      }
                                      var valid4 = _errs27 === errors;
                                    } else {
                                      var valid4 = true;
                                    }
                                    if (valid4) {
                                      if (data9.filename !== void 0) {
                                        const _errs29 = errors;
                                        if (typeof data9.filename !== "string") {
                                          const err5 = { instancePath: instancePath + "/media/filename", schemaPath: "#/$defs/ChannelPreviewMedia/properties/filename/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                          if (vErrors === null) {
                                            vErrors = [err5];
                                          } else {
                                            vErrors.push(err5);
                                          }
                                          errors++;
                                        }
                                        var valid4 = _errs29 === errors;
                                      } else {
                                        var valid4 = true;
                                      }
                                      if (valid4) {
                                        if (data9.height !== void 0) {
                                          let data13 = data9.height;
                                          const _errs31 = errors;
                                          if (!(typeof data13 == "number" && (!(data13 % 1) && !isNaN(data13)) && isFinite(data13)) && data13 !== null) {
                                            const err6 = { instancePath: instancePath + "/media/height", schemaPath: "#/$defs/ChannelPreviewMedia/properties/height/type", keyword: "type", params: { type: schema44.properties.height.type }, message: "must be integer,null" };
                                            if (vErrors === null) {
                                              vErrors = [err6];
                                            } else {
                                              vErrors.push(err6);
                                            }
                                            errors++;
                                          }
                                          if (errors === _errs31) {
                                            if (typeof data13 == "number" && isFinite(data13)) {
                                              if (data13 > 2147483647 || isNaN(data13)) {
                                                const err7 = { instancePath: instancePath + "/media/height", schemaPath: "#/$defs/ChannelPreviewMedia/properties/height/maximum", keyword: "maximum", params: { comparison: "<=", limit: 2147483647 }, message: "must be <= 2147483647" };
                                                if (vErrors === null) {
                                                  vErrors = [err7];
                                                } else {
                                                  vErrors.push(err7);
                                                }
                                                errors++;
                                              } else {
                                                if (data13 < -2147483648 || isNaN(data13)) {
                                                  const err8 = { instancePath: instancePath + "/media/height", schemaPath: "#/$defs/ChannelPreviewMedia/properties/height/minimum", keyword: "minimum", params: { comparison: ">=", limit: -2147483648 }, message: "must be >= -2147483648" };
                                                  if (vErrors === null) {
                                                    vErrors = [err8];
                                                  } else {
                                                    vErrors.push(err8);
                                                  }
                                                  errors++;
                                                }
                                              }
                                            }
                                          }
                                          var valid4 = _errs31 === errors;
                                        } else {
                                          var valid4 = true;
                                        }
                                        if (valid4) {
                                          if (data9.width !== void 0) {
                                            let data14 = data9.width;
                                            const _errs33 = errors;
                                            if (!(typeof data14 == "number" && (!(data14 % 1) && !isNaN(data14)) && isFinite(data14)) && data14 !== null) {
                                              const err9 = { instancePath: instancePath + "/media/width", schemaPath: "#/$defs/ChannelPreviewMedia/properties/width/type", keyword: "type", params: { type: schema44.properties.width.type }, message: "must be integer,null" };
                                              if (vErrors === null) {
                                                vErrors = [err9];
                                              } else {
                                                vErrors.push(err9);
                                              }
                                              errors++;
                                            }
                                            if (errors === _errs33) {
                                              if (typeof data14 == "number" && isFinite(data14)) {
                                                if (data14 > 2147483647 || isNaN(data14)) {
                                                  const err10 = { instancePath: instancePath + "/media/width", schemaPath: "#/$defs/ChannelPreviewMedia/properties/width/maximum", keyword: "maximum", params: { comparison: "<=", limit: 2147483647 }, message: "must be <= 2147483647" };
                                                  if (vErrors === null) {
                                                    vErrors = [err10];
                                                  } else {
                                                    vErrors.push(err10);
                                                  }
                                                  errors++;
                                                } else {
                                                  if (data14 < -2147483648 || isNaN(data14)) {
                                                    const err11 = { instancePath: instancePath + "/media/width", schemaPath: "#/$defs/ChannelPreviewMedia/properties/width/minimum", keyword: "minimum", params: { comparison: ">=", limit: -2147483648 }, message: "must be >= -2147483648" };
                                                    if (vErrors === null) {
                                                      vErrors = [err11];
                                                    } else {
                                                      vErrors.push(err11);
                                                    }
                                                    errors++;
                                                  }
                                                }
                                              }
                                            }
                                            var valid4 = _errs33 === errors;
                                          } else {
                                            var valid4 = true;
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              } else {
                                const err12 = { instancePath: instancePath + "/media", schemaPath: "#/$defs/ChannelPreviewMedia/type", keyword: "type", params: { type: "object" }, message: "must be object" };
                                if (vErrors === null) {
                                  vErrors = [err12];
                                } else {
                                  vErrors.push(err12);
                                }
                                errors++;
                              }
                            }
                            var _valid0 = _errs22 === errors;
                            valid2 = valid2 || _valid0;
                            if (_valid0) {
                              var props0 = {};
                              props0.attachment_id = true;
                              props0.content_type = true;
                              props0.filename = true;
                              props0.height = true;
                              props0.width = true;
                            }
                            const _errs35 = errors;
                            if (data9 !== null) {
                              const err13 = { instancePath: instancePath + "/media", schemaPath: "#/properties/media/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                              if (vErrors === null) {
                                vErrors = [err13];
                              } else {
                                vErrors.push(err13);
                              }
                              errors++;
                            }
                            var _valid0 = _errs35 === errors;
                            valid2 = valid2 || _valid0;
                            if (!valid2) {
                              const err14 = { instancePath: instancePath + "/media", schemaPath: "#/properties/media/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                              if (vErrors === null) {
                                vErrors = [err14];
                              } else {
                                vErrors.push(err14);
                              }
                              errors++;
                              validate29.errors = vErrors;
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
                            if (data.message_id !== void 0) {
                              let data15 = data.message_id;
                              const _errs37 = errors;
                              if (errors === _errs37) {
                                if (typeof data15 === "string") {
                                  if (func1(data15) < 1) {
                                    validate29.errors = [{ instancePath: instancePath + "/message_id", schemaPath: "#/properties/message_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                                    return false;
                                  } else {
                                    if (!pattern4.test(data15)) {
                                      validate29.errors = [{ instancePath: instancePath + "/message_id", schemaPath: "#/properties/message_id/pattern", keyword: "pattern", params: { pattern: "^[0-9]+$" }, message: 'must match pattern "^[0-9]+$"' }];
                                      return false;
                                    }
                                  }
                                } else {
                                  validate29.errors = [{ instancePath: instancePath + "/message_id", schemaPath: "#/properties/message_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                  return false;
                                }
                              }
                              var valid0 = _errs37 === errors;
                            } else {
                              var valid0 = true;
                            }
                            if (valid0) {
                              if (data.message_type !== void 0) {
                                let data16 = data.message_type;
                                const _errs39 = errors;
                                if (!(typeof data16 == "number" && (!(data16 % 1) && !isNaN(data16)) && isFinite(data16))) {
                                  validate29.errors = [{ instancePath: instancePath + "/message_type", schemaPath: "#/properties/message_type/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                                  return false;
                                }
                                if (errors === _errs39) {
                                  if (typeof data16 == "number" && isFinite(data16)) {
                                    if (data16 > 2147483647 || isNaN(data16)) {
                                      validate29.errors = [{ instancePath: instancePath + "/message_type", schemaPath: "#/properties/message_type/maximum", keyword: "maximum", params: { comparison: "<=", limit: 2147483647 }, message: "must be <= 2147483647" }];
                                      return false;
                                    } else {
                                      if (data16 < -2147483648 || isNaN(data16)) {
                                        validate29.errors = [{ instancePath: instancePath + "/message_type", schemaPath: "#/properties/message_type/minimum", keyword: "minimum", params: { comparison: ">=", limit: -2147483648 }, message: "must be >= -2147483648" }];
                                        return false;
                                      }
                                    }
                                  }
                                }
                                var valid0 = _errs39 === errors;
                              } else {
                                var valid0 = true;
                              }
                              if (valid0) {
                                if (data.truncated !== void 0) {
                                  const _errs41 = errors;
                                  if (typeof data.truncated !== "boolean") {
                                    validate29.errors = [{ instancePath: instancePath + "/truncated", schemaPath: "#/properties/truncated/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                                    return false;
                                  }
                                  var valid0 = _errs41 === errors;
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
      validate29.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate29.errors = vErrors;
  return errors === 0;
}
validate29.evaluated = { "props": { "attachment_count": true, "author_id": true, "author_kind": true, "author_name": true, "channel_id": true, "content": true, "created_at": true, "encrypted": true, "has_sticker": true, "media": true, "message_id": true, "message_type": true, "truncated": true }, "dynamicProps": false, "dynamicItems": false };
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
    if (Array.isArray(data)) {
      var valid0 = true;
      const len0 = data.length;
      for (let i0 = 0; i0 < len0; i0++) {
        const _errs1 = errors;
        if (!validate29(data[i0], { instancePath: instancePath + "/" + i0, parentData: data, parentDataProperty: i0, rootData, dynamicAnchors })) {
          vErrors = vErrors === null ? validate29.errors : vErrors.concat(validate29.errors);
          errors = vErrors.length;
        }
        var valid0 = _errs1 === errors;
        if (!valid0) {
          break;
        }
      }
    } else {
      validate28.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
      return false;
    }
  }
  validate28.errors = vErrors;
  return errors === 0;
}
validate28.evaluated = { "items": true, "dynamicProps": false, "dynamicItems": false };
var isCreateGuildRequest = validate31;
var schema45 = { "$id": "urn:paracord:contract:CreateGuildRequest", "$schema": "https://json-schema.org/draft/2020-12/schema", "properties": { "icon": { "type": ["string", "null"] }, "name": { "type": "string" } }, "required": ["name"], "title": "CreateGuildRequest", "type": "object" };
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
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.name === void 0 && (missing0 = "name")) {
        validate31.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.icon !== void 0) {
          let data0 = data.icon;
          const _errs1 = errors;
          if (typeof data0 !== "string" && data0 !== null) {
            validate31.errors = [{ instancePath: instancePath + "/icon", schemaPath: "#/properties/icon/type", keyword: "type", params: { type: schema45.properties.icon.type }, message: "must be string,null" }];
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
              validate31.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
        }
      }
    } else {
      validate31.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate31.errors = vErrors;
  return errors === 0;
}
validate31.evaluated = { "props": { "icon": true, "name": true }, "dynamicProps": false, "dynamicItems": false };
var isCreateInviteRequest = validate32;
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
      if (data.max_age !== void 0) {
        let data0 = data.max_age;
        const _errs1 = errors;
        if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)) && isFinite(data0))) {
          validate32.errors = [{ instancePath: instancePath + "/max_age", schemaPath: "#/properties/max_age/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
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
            validate32.errors = [{ instancePath: instancePath + "/max_uses", schemaPath: "#/properties/max_uses/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
            return false;
          }
          var valid0 = _errs3 === errors;
        } else {
          var valid0 = true;
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
validate32.evaluated = { "props": { "max_age": true, "max_uses": true }, "dynamicProps": false, "dynamicItems": false };
var isCreateRelationshipRequest = validate33;
var schema47 = { "$id": "urn:paracord:contract:CreateRelationshipRequest", "$schema": "https://json-schema.org/draft/2020-12/schema", "properties": { "type": { "description": "Only 1 (friend request) and 2 (block) are accepted.", "format": "int32", "type": ["integer", "null"] }, "user_id": { "type": ["string", "null"] }, "username": { "type": ["string", "null"] } }, "title": "CreateRelationshipRequest", "type": "object" };
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
    if (data && typeof data == "object" && !Array.isArray(data)) {
      if (data.type !== void 0) {
        let data0 = data.type;
        const _errs1 = errors;
        if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)) && isFinite(data0)) && data0 !== null) {
          validate33.errors = [{ instancePath: instancePath + "/type", schemaPath: "#/properties/type/type", keyword: "type", params: { type: schema47.properties.type.type }, message: "must be integer,null" }];
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
            validate33.errors = [{ instancePath: instancePath + "/user_id", schemaPath: "#/properties/user_id/type", keyword: "type", params: { type: schema47.properties.user_id.type }, message: "must be string,null" }];
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
              validate33.errors = [{ instancePath: instancePath + "/username", schemaPath: "#/properties/username/type", keyword: "type", params: { type: schema47.properties.username.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs5 === errors;
          } else {
            var valid0 = true;
          }
        }
      }
    } else {
      validate33.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate33.errors = vErrors;
  return errors === 0;
}
validate33.evaluated = { "props": { "type": true, "user_id": true, "username": true }, "dynamicProps": false, "dynamicItems": false };
var isCredentialClaimRequest = validate34;
var schema48 = { "$defs": { "IdentityProof": { "description": "A signature over a server challenge, proving possession of the identity key.", "properties": { "nonce": { "description": "The nonce `/auth/challenge` issued.", "type": "string" }, "signature": { "description": 'hex Ed25519 signature over\n`"<purpose>:" + nonce + ":" + timestamp + ":" + origin`, where purpose is\n`paracord/credential/v2/register` or `paracord/credential/v2/reset`.', "type": "string" }, "timestamp": { "description": "The timestamp `/auth/challenge` issued (Unix seconds).", "format": "int64", "type": "integer" } }, "required": ["nonce", "timestamp", "signature"], "type": "object" }, "InitialServerTemplate": { "description": "The first server a desktop host or a headless install creates at the claim.", "oneOf": [{ "const": "friends", "description": "Text channels `general`, `clips`, `plans`; voice channels `Lounge`,\n`Gaming` (spec \xA72.7).", "type": "string" }] }, "KdfParams": { "description": 'scrypt parameters as sent on the wire. Stored per credential as\n`"scrypt:<log_n>:<r>:<p>"` (see [`KdfParams::to_db_text`]).', "properties": { "alg": { "description": 'Always `"scrypt"`.', "type": "string" }, "log_n": { "description": "log2 of scrypt's N.", "format": "uint8", "maximum": 255, "minimum": 0, "type": "integer" }, "p": { "format": "uint32", "minimum": 0, "type": "integer" }, "r": { "format": "uint32", "minimum": 0, "type": "integer" } }, "required": ["alg", "log_n", "r", "p"], "type": "object" }, "NewCredential": { "description": "A freshly derived credential: what the server stores in place of a password.", "properties": { "auth_key": { "description": "b64url of the 32-byte HKDF output `paracord/credential/v2/auth`.", "type": "string" }, "kdf": { "$ref": "#/$defs/KdfParams" }, "salt": { "description": "b64url of 32 random bytes.", "type": "string" } }, "required": ["salt", "kdf", "auth_key"], "type": "object" }, "NewIdentity": { "description": "The identity as the server keeps it: the public key and the private key\nwrapped under the password-derived wrap key.", "properties": { "proof": { "$ref": "#/$defs/IdentityProof" }, "public_key": { "description": "hex of the 32-byte Ed25519 public key.", "type": "string" }, "wrap_alg": { "description": '`"aes256gcm-v2"` ([`WRAP_ALG_V2`]).', "type": "string" }, "wrapped_key": { "description": "b64url of `iv12 || ciphertext+tag` (12 + 48 bytes).", "type": "string" } }, "required": ["public_key", "wrapped_key", "wrap_alg", "proof"], "type": "object" }, "RegistrationMode": { "description": "Who can create an account on an instance. The same spelling as the\n`[auth] registration_mode` config value.", "enum": ["open", "invite_only"], "type": "string" } }, "$id": "urn:paracord:contract:CredentialClaimRequest", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "`POST /api/v1/setup/credential-claim`: the legacy `ClaimRequest` minus\n`password`, plus the credential, identity, hue and template. Answers 201\nwith the same `ClaimResponse` as `/setup/claim`.", "properties": { "credential": { "$ref": "#/$defs/NewCredential" }, "display_name": { "default": null, "type": ["string", "null"] }, "email": { "default": null, "type": ["string", "null"] }, "identity": { "$ref": "#/$defs/NewIdentity" }, "initial_space_hue": { "description": "The first server's color, 0-359.", "format": "int16", "maximum": 359, "minimum": 0, "type": "integer" }, "initial_space_icon": { "default": null, "type": ["string", "null"] }, "initial_space_name": { "type": "string" }, "initial_space_template": { "$ref": "#/$defs/InitialServerTemplate" }, "instance_name": { "type": "string" }, "registration_mode": { "anyOf": [{ "$ref": "#/$defs/RegistrationMode" }, { "type": "null" }], "default": null, "description": "Saved with the server when given; otherwise the config file's\n`[auth] registration_mode` stands." }, "token": { "type": "string" }, "username": { "type": "string" } }, "required": ["token", "username", "instance_name", "initial_space_name", "initial_space_hue", "initial_space_template", "credential", "identity"], "title": "CredentialClaimRequest", "type": "object" };
var schema54 = { "description": "Who can create an account on an instance. The same spelling as the\n`[auth] registration_mode` config value.", "enum": ["open", "invite_only"], "type": "string" };
function validate35(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate35.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.salt === void 0 && (missing0 = "salt") || data.kdf === void 0 && (missing0 = "kdf") || data.auth_key === void 0 && (missing0 = "auth_key")) {
        validate35.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.auth_key !== void 0) {
          const _errs1 = errors;
          if (typeof data.auth_key !== "string") {
            validate35.errors = [{ instancePath: instancePath + "/auth_key", schemaPath: "#/properties/auth_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.kdf !== void 0) {
            let data1 = data.kdf;
            const _errs3 = errors;
            const _errs4 = errors;
            if (errors === _errs4) {
              if (data1 && typeof data1 == "object" && !Array.isArray(data1)) {
                let missing1;
                if (data1.alg === void 0 && (missing1 = "alg") || data1.log_n === void 0 && (missing1 = "log_n") || data1.r === void 0 && (missing1 = "r") || data1.p === void 0 && (missing1 = "p")) {
                  validate35.errors = [{ instancePath: instancePath + "/kdf", schemaPath: "#/$defs/KdfParams/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                  return false;
                } else {
                  if (data1.alg !== void 0) {
                    const _errs6 = errors;
                    if (typeof data1.alg !== "string") {
                      validate35.errors = [{ instancePath: instancePath + "/kdf/alg", schemaPath: "#/$defs/KdfParams/properties/alg/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid2 = _errs6 === errors;
                  } else {
                    var valid2 = true;
                  }
                  if (valid2) {
                    if (data1.log_n !== void 0) {
                      let data3 = data1.log_n;
                      const _errs8 = errors;
                      if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3))) {
                        validate35.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      if (errors === _errs8) {
                        if (typeof data3 == "number" && isFinite(data3)) {
                          if (data3 > 255 || isNaN(data3)) {
                            validate35.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/maximum", keyword: "maximum", params: { comparison: "<=", limit: 255 }, message: "must be <= 255" }];
                            return false;
                          } else {
                            if (data3 < 0 || isNaN(data3)) {
                              validate35.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                              return false;
                            }
                          }
                        }
                      }
                      var valid2 = _errs8 === errors;
                    } else {
                      var valid2 = true;
                    }
                    if (valid2) {
                      if (data1.p !== void 0) {
                        let data4 = data1.p;
                        const _errs10 = errors;
                        if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
                          validate35.errors = [{ instancePath: instancePath + "/kdf/p", schemaPath: "#/$defs/KdfParams/properties/p/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                          return false;
                        }
                        if (errors === _errs10) {
                          if (typeof data4 == "number" && isFinite(data4)) {
                            if (data4 < 0 || isNaN(data4)) {
                              validate35.errors = [{ instancePath: instancePath + "/kdf/p", schemaPath: "#/$defs/KdfParams/properties/p/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                              return false;
                            }
                          }
                        }
                        var valid2 = _errs10 === errors;
                      } else {
                        var valid2 = true;
                      }
                      if (valid2) {
                        if (data1.r !== void 0) {
                          let data5 = data1.r;
                          const _errs12 = errors;
                          if (!(typeof data5 == "number" && (!(data5 % 1) && !isNaN(data5)) && isFinite(data5))) {
                            validate35.errors = [{ instancePath: instancePath + "/kdf/r", schemaPath: "#/$defs/KdfParams/properties/r/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                            return false;
                          }
                          if (errors === _errs12) {
                            if (typeof data5 == "number" && isFinite(data5)) {
                              if (data5 < 0 || isNaN(data5)) {
                                validate35.errors = [{ instancePath: instancePath + "/kdf/r", schemaPath: "#/$defs/KdfParams/properties/r/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                return false;
                              }
                            }
                          }
                          var valid2 = _errs12 === errors;
                        } else {
                          var valid2 = true;
                        }
                      }
                    }
                  }
                }
              } else {
                validate35.errors = [{ instancePath: instancePath + "/kdf", schemaPath: "#/$defs/KdfParams/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                return false;
              }
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.salt !== void 0) {
              const _errs14 = errors;
              if (typeof data.salt !== "string") {
                validate35.errors = [{ instancePath: instancePath + "/salt", schemaPath: "#/properties/salt/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              var valid0 = _errs14 === errors;
            } else {
              var valid0 = true;
            }
          }
        }
      }
    } else {
      validate35.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate35.errors = vErrors;
  return errors === 0;
}
validate35.evaluated = { "props": { "auth_key": true, "kdf": true, "salt": true }, "dynamicProps": false, "dynamicItems": false };
function validate37(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
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
      if (data.public_key === void 0 && (missing0 = "public_key") || data.wrapped_key === void 0 && (missing0 = "wrapped_key") || data.wrap_alg === void 0 && (missing0 = "wrap_alg") || data.proof === void 0 && (missing0 = "proof")) {
        validate37.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.proof !== void 0) {
          let data0 = data.proof;
          const _errs1 = errors;
          const _errs2 = errors;
          if (errors === _errs2) {
            if (data0 && typeof data0 == "object" && !Array.isArray(data0)) {
              let missing1;
              if (data0.nonce === void 0 && (missing1 = "nonce") || data0.timestamp === void 0 && (missing1 = "timestamp") || data0.signature === void 0 && (missing1 = "signature")) {
                validate37.errors = [{ instancePath: instancePath + "/proof", schemaPath: "#/$defs/IdentityProof/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                return false;
              } else {
                if (data0.nonce !== void 0) {
                  const _errs4 = errors;
                  if (typeof data0.nonce !== "string") {
                    validate37.errors = [{ instancePath: instancePath + "/proof/nonce", schemaPath: "#/$defs/IdentityProof/properties/nonce/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                  var valid2 = _errs4 === errors;
                } else {
                  var valid2 = true;
                }
                if (valid2) {
                  if (data0.signature !== void 0) {
                    const _errs6 = errors;
                    if (typeof data0.signature !== "string") {
                      validate37.errors = [{ instancePath: instancePath + "/proof/signature", schemaPath: "#/$defs/IdentityProof/properties/signature/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid2 = _errs6 === errors;
                  } else {
                    var valid2 = true;
                  }
                  if (valid2) {
                    if (data0.timestamp !== void 0) {
                      let data3 = data0.timestamp;
                      const _errs8 = errors;
                      if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3))) {
                        validate37.errors = [{ instancePath: instancePath + "/proof/timestamp", schemaPath: "#/$defs/IdentityProof/properties/timestamp/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      var valid2 = _errs8 === errors;
                    } else {
                      var valid2 = true;
                    }
                  }
                }
              }
            } else {
              validate37.errors = [{ instancePath: instancePath + "/proof", schemaPath: "#/$defs/IdentityProof/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
              return false;
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.public_key !== void 0) {
            const _errs10 = errors;
            if (typeof data.public_key !== "string") {
              validate37.errors = [{ instancePath: instancePath + "/public_key", schemaPath: "#/properties/public_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs10 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.wrap_alg !== void 0) {
              const _errs12 = errors;
              if (typeof data.wrap_alg !== "string") {
                validate37.errors = [{ instancePath: instancePath + "/wrap_alg", schemaPath: "#/properties/wrap_alg/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              var valid0 = _errs12 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.wrapped_key !== void 0) {
                const _errs14 = errors;
                if (typeof data.wrapped_key !== "string") {
                  validate37.errors = [{ instancePath: instancePath + "/wrapped_key", schemaPath: "#/properties/wrapped_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid0 = _errs14 === errors;
              } else {
                var valid0 = true;
              }
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
validate37.evaluated = { "props": { "proof": true, "public_key": true, "wrap_alg": true, "wrapped_key": true }, "dynamicProps": false, "dynamicItems": false };
function validate34(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
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
      if (data.token === void 0 && (missing0 = "token") || data.username === void 0 && (missing0 = "username") || data.instance_name === void 0 && (missing0 = "instance_name") || data.initial_space_name === void 0 && (missing0 = "initial_space_name") || data.initial_space_hue === void 0 && (missing0 = "initial_space_hue") || data.initial_space_template === void 0 && (missing0 = "initial_space_template") || data.credential === void 0 && (missing0 = "credential") || data.identity === void 0 && (missing0 = "identity")) {
        validate34.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.credential !== void 0) {
          const _errs1 = errors;
          if (!validate35(data.credential, { instancePath: instancePath + "/credential", parentData: data, parentDataProperty: "credential", rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate35.errors : vErrors.concat(validate35.errors);
            errors = vErrors.length;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.display_name !== void 0) {
            let data1 = data.display_name;
            const _errs2 = errors;
            if (typeof data1 !== "string" && data1 !== null) {
              validate34.errors = [{ instancePath: instancePath + "/display_name", schemaPath: "#/properties/display_name/type", keyword: "type", params: { type: schema48.properties.display_name.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs2 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.email !== void 0) {
              let data2 = data.email;
              const _errs4 = errors;
              if (typeof data2 !== "string" && data2 !== null) {
                validate34.errors = [{ instancePath: instancePath + "/email", schemaPath: "#/properties/email/type", keyword: "type", params: { type: schema48.properties.email.type }, message: "must be string,null" }];
                return false;
              }
              var valid0 = _errs4 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.identity !== void 0) {
                const _errs6 = errors;
                if (!validate37(data.identity, { instancePath: instancePath + "/identity", parentData: data, parentDataProperty: "identity", rootData, dynamicAnchors })) {
                  vErrors = vErrors === null ? validate37.errors : vErrors.concat(validate37.errors);
                  errors = vErrors.length;
                }
                var valid0 = _errs6 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.initial_space_hue !== void 0) {
                  let data4 = data.initial_space_hue;
                  const _errs7 = errors;
                  if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
                    validate34.errors = [{ instancePath: instancePath + "/initial_space_hue", schemaPath: "#/properties/initial_space_hue/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                    return false;
                  }
                  if (errors === _errs7) {
                    if (typeof data4 == "number" && isFinite(data4)) {
                      if (data4 > 359 || isNaN(data4)) {
                        validate34.errors = [{ instancePath: instancePath + "/initial_space_hue", schemaPath: "#/properties/initial_space_hue/maximum", keyword: "maximum", params: { comparison: "<=", limit: 359 }, message: "must be <= 359" }];
                        return false;
                      } else {
                        if (data4 < 0 || isNaN(data4)) {
                          validate34.errors = [{ instancePath: instancePath + "/initial_space_hue", schemaPath: "#/properties/initial_space_hue/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
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
                  if (data.initial_space_icon !== void 0) {
                    let data5 = data.initial_space_icon;
                    const _errs9 = errors;
                    if (typeof data5 !== "string" && data5 !== null) {
                      validate34.errors = [{ instancePath: instancePath + "/initial_space_icon", schemaPath: "#/properties/initial_space_icon/type", keyword: "type", params: { type: schema48.properties.initial_space_icon.type }, message: "must be string,null" }];
                      return false;
                    }
                    var valid0 = _errs9 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.initial_space_name !== void 0) {
                      const _errs11 = errors;
                      if (typeof data.initial_space_name !== "string") {
                        validate34.errors = [{ instancePath: instancePath + "/initial_space_name", schemaPath: "#/properties/initial_space_name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                        return false;
                      }
                      var valid0 = _errs11 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.initial_space_template !== void 0) {
                        let data7 = data.initial_space_template;
                        const _errs13 = errors;
                        const _errs15 = errors;
                        let valid2 = false;
                        let passing0 = null;
                        const _errs16 = errors;
                        if (typeof data7 !== "string") {
                          const err0 = { instancePath: instancePath + "/initial_space_template", schemaPath: "#/$defs/InitialServerTemplate/oneOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                          if (vErrors === null) {
                            vErrors = [err0];
                          } else {
                            vErrors.push(err0);
                          }
                          errors++;
                        }
                        if ("friends" !== data7) {
                          const err1 = { instancePath: instancePath + "/initial_space_template", schemaPath: "#/$defs/InitialServerTemplate/oneOf/0/const", keyword: "const", params: { allowedValue: "friends" }, message: "must be equal to constant" };
                          if (vErrors === null) {
                            vErrors = [err1];
                          } else {
                            vErrors.push(err1);
                          }
                          errors++;
                        }
                        var _valid0 = _errs16 === errors;
                        if (_valid0) {
                          valid2 = true;
                          passing0 = 0;
                        }
                        if (!valid2) {
                          const err2 = { instancePath: instancePath + "/initial_space_template", schemaPath: "#/$defs/InitialServerTemplate/oneOf", keyword: "oneOf", params: { passingSchemas: passing0 }, message: "must match exactly one schema in oneOf" };
                          if (vErrors === null) {
                            vErrors = [err2];
                          } else {
                            vErrors.push(err2);
                          }
                          errors++;
                          validate34.errors = vErrors;
                          return false;
                        } else {
                          errors = _errs15;
                          if (vErrors !== null) {
                            if (_errs15) {
                              vErrors.length = _errs15;
                            } else {
                              vErrors = null;
                            }
                          }
                        }
                        var valid0 = _errs13 === errors;
                      } else {
                        var valid0 = true;
                      }
                      if (valid0) {
                        if (data.instance_name !== void 0) {
                          const _errs18 = errors;
                          if (typeof data.instance_name !== "string") {
                            validate34.errors = [{ instancePath: instancePath + "/instance_name", schemaPath: "#/properties/instance_name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                            return false;
                          }
                          var valid0 = _errs18 === errors;
                        } else {
                          var valid0 = true;
                        }
                        if (valid0) {
                          if (data.registration_mode !== void 0) {
                            let data9 = data.registration_mode;
                            const _errs20 = errors;
                            const _errs21 = errors;
                            let valid3 = false;
                            const _errs22 = errors;
                            if (typeof data9 !== "string") {
                              const err3 = { instancePath: instancePath + "/registration_mode", schemaPath: "#/$defs/RegistrationMode/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                              if (vErrors === null) {
                                vErrors = [err3];
                              } else {
                                vErrors.push(err3);
                              }
                              errors++;
                            }
                            if (!(data9 === "open" || data9 === "invite_only")) {
                              const err4 = { instancePath: instancePath + "/registration_mode", schemaPath: "#/$defs/RegistrationMode/enum", keyword: "enum", params: { allowedValues: schema54.enum }, message: "must be equal to one of the allowed values" };
                              if (vErrors === null) {
                                vErrors = [err4];
                              } else {
                                vErrors.push(err4);
                              }
                              errors++;
                            }
                            var _valid1 = _errs22 === errors;
                            valid3 = valid3 || _valid1;
                            const _errs25 = errors;
                            if (data9 !== null) {
                              const err5 = { instancePath: instancePath + "/registration_mode", schemaPath: "#/properties/registration_mode/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                              if (vErrors === null) {
                                vErrors = [err5];
                              } else {
                                vErrors.push(err5);
                              }
                              errors++;
                            }
                            var _valid1 = _errs25 === errors;
                            valid3 = valid3 || _valid1;
                            if (!valid3) {
                              const err6 = { instancePath: instancePath + "/registration_mode", schemaPath: "#/properties/registration_mode/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                              if (vErrors === null) {
                                vErrors = [err6];
                              } else {
                                vErrors.push(err6);
                              }
                              errors++;
                              validate34.errors = vErrors;
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
                            if (data.token !== void 0) {
                              const _errs27 = errors;
                              if (typeof data.token !== "string") {
                                validate34.errors = [{ instancePath: instancePath + "/token", schemaPath: "#/properties/token/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                return false;
                              }
                              var valid0 = _errs27 === errors;
                            } else {
                              var valid0 = true;
                            }
                            if (valid0) {
                              if (data.username !== void 0) {
                                const _errs29 = errors;
                                if (typeof data.username !== "string") {
                                  validate34.errors = [{ instancePath: instancePath + "/username", schemaPath: "#/properties/username/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                  return false;
                                }
                                var valid0 = _errs29 === errors;
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
    } else {
      validate34.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate34.errors = vErrors;
  return errors === 0;
}
validate34.evaluated = { "props": { "credential": true, "display_name": true, "email": true, "identity": true, "initial_space_hue": true, "initial_space_icon": true, "initial_space_name": true, "initial_space_template": true, "instance_name": true, "registration_mode": true, "token": true, "username": true }, "dynamicProps": false, "dynamicItems": false };
var isCredentialEmailResetRequest = validate39;
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
      if (data.salt === void 0 && (missing0 = "salt") || data.kdf === void 0 && (missing0 = "kdf") || data.auth_key === void 0 && (missing0 = "auth_key")) {
        validate40.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.auth_key !== void 0) {
          const _errs1 = errors;
          if (typeof data.auth_key !== "string") {
            validate40.errors = [{ instancePath: instancePath + "/auth_key", schemaPath: "#/properties/auth_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.kdf !== void 0) {
            let data1 = data.kdf;
            const _errs3 = errors;
            const _errs4 = errors;
            if (errors === _errs4) {
              if (data1 && typeof data1 == "object" && !Array.isArray(data1)) {
                let missing1;
                if (data1.alg === void 0 && (missing1 = "alg") || data1.log_n === void 0 && (missing1 = "log_n") || data1.r === void 0 && (missing1 = "r") || data1.p === void 0 && (missing1 = "p")) {
                  validate40.errors = [{ instancePath: instancePath + "/kdf", schemaPath: "#/$defs/KdfParams/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                  return false;
                } else {
                  if (data1.alg !== void 0) {
                    const _errs6 = errors;
                    if (typeof data1.alg !== "string") {
                      validate40.errors = [{ instancePath: instancePath + "/kdf/alg", schemaPath: "#/$defs/KdfParams/properties/alg/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid2 = _errs6 === errors;
                  } else {
                    var valid2 = true;
                  }
                  if (valid2) {
                    if (data1.log_n !== void 0) {
                      let data3 = data1.log_n;
                      const _errs8 = errors;
                      if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3))) {
                        validate40.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      if (errors === _errs8) {
                        if (typeof data3 == "number" && isFinite(data3)) {
                          if (data3 > 255 || isNaN(data3)) {
                            validate40.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/maximum", keyword: "maximum", params: { comparison: "<=", limit: 255 }, message: "must be <= 255" }];
                            return false;
                          } else {
                            if (data3 < 0 || isNaN(data3)) {
                              validate40.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                              return false;
                            }
                          }
                        }
                      }
                      var valid2 = _errs8 === errors;
                    } else {
                      var valid2 = true;
                    }
                    if (valid2) {
                      if (data1.p !== void 0) {
                        let data4 = data1.p;
                        const _errs10 = errors;
                        if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
                          validate40.errors = [{ instancePath: instancePath + "/kdf/p", schemaPath: "#/$defs/KdfParams/properties/p/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                          return false;
                        }
                        if (errors === _errs10) {
                          if (typeof data4 == "number" && isFinite(data4)) {
                            if (data4 < 0 || isNaN(data4)) {
                              validate40.errors = [{ instancePath: instancePath + "/kdf/p", schemaPath: "#/$defs/KdfParams/properties/p/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                              return false;
                            }
                          }
                        }
                        var valid2 = _errs10 === errors;
                      } else {
                        var valid2 = true;
                      }
                      if (valid2) {
                        if (data1.r !== void 0) {
                          let data5 = data1.r;
                          const _errs12 = errors;
                          if (!(typeof data5 == "number" && (!(data5 % 1) && !isNaN(data5)) && isFinite(data5))) {
                            validate40.errors = [{ instancePath: instancePath + "/kdf/r", schemaPath: "#/$defs/KdfParams/properties/r/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                            return false;
                          }
                          if (errors === _errs12) {
                            if (typeof data5 == "number" && isFinite(data5)) {
                              if (data5 < 0 || isNaN(data5)) {
                                validate40.errors = [{ instancePath: instancePath + "/kdf/r", schemaPath: "#/$defs/KdfParams/properties/r/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                return false;
                              }
                            }
                          }
                          var valid2 = _errs12 === errors;
                        } else {
                          var valid2 = true;
                        }
                      }
                    }
                  }
                }
              } else {
                validate40.errors = [{ instancePath: instancePath + "/kdf", schemaPath: "#/$defs/KdfParams/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                return false;
              }
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.salt !== void 0) {
              const _errs14 = errors;
              if (typeof data.salt !== "string") {
                validate40.errors = [{ instancePath: instancePath + "/salt", schemaPath: "#/properties/salt/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              var valid0 = _errs14 === errors;
            } else {
              var valid0 = true;
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
validate40.evaluated = { "props": { "auth_key": true, "kdf": true, "salt": true }, "dynamicProps": false, "dynamicItems": false };
function validate42(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
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
      if (data.public_key === void 0 && (missing0 = "public_key") || data.wrapped_key === void 0 && (missing0 = "wrapped_key") || data.wrap_alg === void 0 && (missing0 = "wrap_alg") || data.proof === void 0 && (missing0 = "proof")) {
        validate42.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.proof !== void 0) {
          let data0 = data.proof;
          const _errs1 = errors;
          const _errs2 = errors;
          if (errors === _errs2) {
            if (data0 && typeof data0 == "object" && !Array.isArray(data0)) {
              let missing1;
              if (data0.nonce === void 0 && (missing1 = "nonce") || data0.timestamp === void 0 && (missing1 = "timestamp") || data0.signature === void 0 && (missing1 = "signature")) {
                validate42.errors = [{ instancePath: instancePath + "/proof", schemaPath: "#/$defs/IdentityProof/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                return false;
              } else {
                if (data0.nonce !== void 0) {
                  const _errs4 = errors;
                  if (typeof data0.nonce !== "string") {
                    validate42.errors = [{ instancePath: instancePath + "/proof/nonce", schemaPath: "#/$defs/IdentityProof/properties/nonce/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                  var valid2 = _errs4 === errors;
                } else {
                  var valid2 = true;
                }
                if (valid2) {
                  if (data0.signature !== void 0) {
                    const _errs6 = errors;
                    if (typeof data0.signature !== "string") {
                      validate42.errors = [{ instancePath: instancePath + "/proof/signature", schemaPath: "#/$defs/IdentityProof/properties/signature/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid2 = _errs6 === errors;
                  } else {
                    var valid2 = true;
                  }
                  if (valid2) {
                    if (data0.timestamp !== void 0) {
                      let data3 = data0.timestamp;
                      const _errs8 = errors;
                      if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3))) {
                        validate42.errors = [{ instancePath: instancePath + "/proof/timestamp", schemaPath: "#/$defs/IdentityProof/properties/timestamp/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      var valid2 = _errs8 === errors;
                    } else {
                      var valid2 = true;
                    }
                  }
                }
              }
            } else {
              validate42.errors = [{ instancePath: instancePath + "/proof", schemaPath: "#/$defs/IdentityProof/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
              return false;
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.public_key !== void 0) {
            const _errs10 = errors;
            if (typeof data.public_key !== "string") {
              validate42.errors = [{ instancePath: instancePath + "/public_key", schemaPath: "#/properties/public_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs10 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.wrap_alg !== void 0) {
              const _errs12 = errors;
              if (typeof data.wrap_alg !== "string") {
                validate42.errors = [{ instancePath: instancePath + "/wrap_alg", schemaPath: "#/properties/wrap_alg/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              var valid0 = _errs12 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.wrapped_key !== void 0) {
                const _errs14 = errors;
                if (typeof data.wrapped_key !== "string") {
                  validate42.errors = [{ instancePath: instancePath + "/wrapped_key", schemaPath: "#/properties/wrapped_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid0 = _errs14 === errors;
              } else {
                var valid0 = true;
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
validate42.evaluated = { "props": { "proof": true, "public_key": true, "wrap_alg": true, "wrapped_key": true }, "dynamicProps": false, "dynamicItems": false };
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
      if (data.token === void 0 && (missing0 = "token") || data.credential === void 0 && (missing0 = "credential") || data.identity === void 0 && (missing0 = "identity")) {
        validate39.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.credential !== void 0) {
          const _errs1 = errors;
          if (!validate40(data.credential, { instancePath: instancePath + "/credential", parentData: data, parentDataProperty: "credential", rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate40.errors : vErrors.concat(validate40.errors);
            errors = vErrors.length;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.identity !== void 0) {
            const _errs2 = errors;
            if (!validate42(data.identity, { instancePath: instancePath + "/identity", parentData: data, parentDataProperty: "identity", rootData, dynamicAnchors })) {
              vErrors = vErrors === null ? validate42.errors : vErrors.concat(validate42.errors);
              errors = vErrors.length;
            }
            var valid0 = _errs2 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.token !== void 0) {
              const _errs3 = errors;
              if (typeof data.token !== "string") {
                validate39.errors = [{ instancePath: instancePath + "/token", schemaPath: "#/properties/token/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              var valid0 = _errs3 === errors;
            } else {
              var valid0 = true;
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
validate39.evaluated = { "props": { "credential": true, "identity": true, "token": true }, "dynamicProps": false, "dynamicItems": false };
var isCredentialEpochResponse = validate44;
function validate44(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
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
      if (data.epoch === void 0 && (missing0 = "epoch")) {
        validate44.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.epoch !== void 0) {
          let data0 = data.epoch;
          if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)) && isFinite(data0))) {
            validate44.errors = [{ instancePath: instancePath + "/epoch", schemaPath: "#/properties/epoch/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
            return false;
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
validate44.evaluated = { "props": { "epoch": true }, "dynamicProps": false, "dynamicItems": false };
var isCredentialLoginRequest = validate45;
function validate45(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate45.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.identifier === void 0 && (missing0 = "identifier") || data.auth_key === void 0 && (missing0 = "auth_key")) {
        validate45.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.auth_key !== void 0) {
          const _errs1 = errors;
          if (typeof data.auth_key !== "string") {
            validate45.errors = [{ instancePath: instancePath + "/auth_key", schemaPath: "#/properties/auth_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.identifier !== void 0) {
            const _errs3 = errors;
            if (typeof data.identifier !== "string") {
              validate45.errors = [{ instancePath: instancePath + "/identifier", schemaPath: "#/properties/identifier/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
        }
      }
    } else {
      validate45.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate45.errors = vErrors;
  return errors === 0;
}
validate45.evaluated = { "props": { "auth_key": true, "identifier": true }, "dynamicProps": false, "dynamicItems": false };
var isCredentialParams = validate46;
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
  const _errs0 = errors;
  let valid0 = false;
  let passing0 = null;
  const _errs1 = errors;
  if (errors === _errs1) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.version === void 0 && (missing0 = "version")) {
        const err0 = { instancePath, schemaPath: "#/oneOf/0/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" };
        if (vErrors === null) {
          vErrors = [err0];
        } else {
          vErrors.push(err0);
        }
        errors++;
      } else {
        if (data.version !== void 0) {
          if (1 !== data.version) {
            const err1 = { instancePath: instancePath + "/version", schemaPath: "#/oneOf/0/properties/version/const", keyword: "const", params: { allowedValue: 1 }, message: "must be equal to constant" };
            if (vErrors === null) {
              vErrors = [err1];
            } else {
              vErrors.push(err1);
            }
            errors++;
          }
        }
      }
    } else {
      const err2 = { instancePath, schemaPath: "#/oneOf/0/type", keyword: "type", params: { type: "object" }, message: "must be object" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
  }
  var _valid0 = _errs1 === errors;
  if (_valid0) {
    valid0 = true;
    passing0 = 0;
    var props0 = {};
    props0.version = true;
  }
  const _errs4 = errors;
  if (errors === _errs4) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing1;
      if (data.version === void 0 && (missing1 = "version") || data.kdf === void 0 && (missing1 = "kdf") || data.salt === void 0 && (missing1 = "salt") || data.epoch === void 0 && (missing1 = "epoch")) {
        const err3 = { instancePath, schemaPath: "#/oneOf/1/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      } else {
        if (data.epoch !== void 0) {
          let data1 = data.epoch;
          const _errs6 = errors;
          if (!(typeof data1 == "number" && (!(data1 % 1) && !isNaN(data1)) && isFinite(data1))) {
            const err4 = { instancePath: instancePath + "/epoch", schemaPath: "#/oneOf/1/properties/epoch/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
            if (vErrors === null) {
              vErrors = [err4];
            } else {
              vErrors.push(err4);
            }
            errors++;
          }
          var valid2 = _errs6 === errors;
        } else {
          var valid2 = true;
        }
        if (valid2) {
          if (data.kdf !== void 0) {
            let data2 = data.kdf;
            const _errs8 = errors;
            const _errs9 = errors;
            if (errors === _errs9) {
              if (data2 && typeof data2 == "object" && !Array.isArray(data2)) {
                let missing2;
                if (data2.alg === void 0 && (missing2 = "alg") || data2.log_n === void 0 && (missing2 = "log_n") || data2.r === void 0 && (missing2 = "r") || data2.p === void 0 && (missing2 = "p")) {
                  const err5 = { instancePath: instancePath + "/kdf", schemaPath: "#/$defs/KdfParams/required", keyword: "required", params: { missingProperty: missing2 }, message: "must have required property '" + missing2 + "'" };
                  if (vErrors === null) {
                    vErrors = [err5];
                  } else {
                    vErrors.push(err5);
                  }
                  errors++;
                } else {
                  if (data2.alg !== void 0) {
                    const _errs11 = errors;
                    if (typeof data2.alg !== "string") {
                      const err6 = { instancePath: instancePath + "/kdf/alg", schemaPath: "#/$defs/KdfParams/properties/alg/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                      if (vErrors === null) {
                        vErrors = [err6];
                      } else {
                        vErrors.push(err6);
                      }
                      errors++;
                    }
                    var valid4 = _errs11 === errors;
                  } else {
                    var valid4 = true;
                  }
                  if (valid4) {
                    if (data2.log_n !== void 0) {
                      let data4 = data2.log_n;
                      const _errs13 = errors;
                      if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
                        const err7 = { instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
                        if (vErrors === null) {
                          vErrors = [err7];
                        } else {
                          vErrors.push(err7);
                        }
                        errors++;
                      }
                      if (errors === _errs13) {
                        if (typeof data4 == "number" && isFinite(data4)) {
                          if (data4 > 255 || isNaN(data4)) {
                            const err8 = { instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/maximum", keyword: "maximum", params: { comparison: "<=", limit: 255 }, message: "must be <= 255" };
                            if (vErrors === null) {
                              vErrors = [err8];
                            } else {
                              vErrors.push(err8);
                            }
                            errors++;
                          } else {
                            if (data4 < 0 || isNaN(data4)) {
                              const err9 = { instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
                              if (vErrors === null) {
                                vErrors = [err9];
                              } else {
                                vErrors.push(err9);
                              }
                              errors++;
                            }
                          }
                        }
                      }
                      var valid4 = _errs13 === errors;
                    } else {
                      var valid4 = true;
                    }
                    if (valid4) {
                      if (data2.p !== void 0) {
                        let data5 = data2.p;
                        const _errs15 = errors;
                        if (!(typeof data5 == "number" && (!(data5 % 1) && !isNaN(data5)) && isFinite(data5))) {
                          const err10 = { instancePath: instancePath + "/kdf/p", schemaPath: "#/$defs/KdfParams/properties/p/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
                          if (vErrors === null) {
                            vErrors = [err10];
                          } else {
                            vErrors.push(err10);
                          }
                          errors++;
                        }
                        if (errors === _errs15) {
                          if (typeof data5 == "number" && isFinite(data5)) {
                            if (data5 < 0 || isNaN(data5)) {
                              const err11 = { instancePath: instancePath + "/kdf/p", schemaPath: "#/$defs/KdfParams/properties/p/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
                              if (vErrors === null) {
                                vErrors = [err11];
                              } else {
                                vErrors.push(err11);
                              }
                              errors++;
                            }
                          }
                        }
                        var valid4 = _errs15 === errors;
                      } else {
                        var valid4 = true;
                      }
                      if (valid4) {
                        if (data2.r !== void 0) {
                          let data6 = data2.r;
                          const _errs17 = errors;
                          if (!(typeof data6 == "number" && (!(data6 % 1) && !isNaN(data6)) && isFinite(data6))) {
                            const err12 = { instancePath: instancePath + "/kdf/r", schemaPath: "#/$defs/KdfParams/properties/r/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
                            if (vErrors === null) {
                              vErrors = [err12];
                            } else {
                              vErrors.push(err12);
                            }
                            errors++;
                          }
                          if (errors === _errs17) {
                            if (typeof data6 == "number" && isFinite(data6)) {
                              if (data6 < 0 || isNaN(data6)) {
                                const err13 = { instancePath: instancePath + "/kdf/r", schemaPath: "#/$defs/KdfParams/properties/r/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
                                if (vErrors === null) {
                                  vErrors = [err13];
                                } else {
                                  vErrors.push(err13);
                                }
                                errors++;
                              }
                            }
                          }
                          var valid4 = _errs17 === errors;
                        } else {
                          var valid4 = true;
                        }
                      }
                    }
                  }
                }
              } else {
                const err14 = { instancePath: instancePath + "/kdf", schemaPath: "#/$defs/KdfParams/type", keyword: "type", params: { type: "object" }, message: "must be object" };
                if (vErrors === null) {
                  vErrors = [err14];
                } else {
                  vErrors.push(err14);
                }
                errors++;
              }
            }
            var valid2 = _errs8 === errors;
          } else {
            var valid2 = true;
          }
          if (valid2) {
            if (data.salt !== void 0) {
              const _errs19 = errors;
              if (typeof data.salt !== "string") {
                const err15 = { instancePath: instancePath + "/salt", schemaPath: "#/oneOf/1/properties/salt/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err15];
                } else {
                  vErrors.push(err15);
                }
                errors++;
              }
              var valid2 = _errs19 === errors;
            } else {
              var valid2 = true;
            }
            if (valid2) {
              if (data.version !== void 0) {
                const _errs21 = errors;
                if (2 !== data.version) {
                  const err16 = { instancePath: instancePath + "/version", schemaPath: "#/oneOf/1/properties/version/const", keyword: "const", params: { allowedValue: 2 }, message: "must be equal to constant" };
                  if (vErrors === null) {
                    vErrors = [err16];
                  } else {
                    vErrors.push(err16);
                  }
                  errors++;
                }
                var valid2 = _errs21 === errors;
              } else {
                var valid2 = true;
              }
            }
          }
        }
      }
    } else {
      const err17 = { instancePath, schemaPath: "#/oneOf/1/type", keyword: "type", params: { type: "object" }, message: "must be object" };
      if (vErrors === null) {
        vErrors = [err17];
      } else {
        vErrors.push(err17);
      }
      errors++;
    }
  }
  var _valid0 = _errs4 === errors;
  if (_valid0 && valid0) {
    valid0 = false;
    passing0 = [passing0, 1];
  } else {
    if (_valid0) {
      valid0 = true;
      passing0 = 1;
      if (props0 !== true) {
        props0 = props0 || {};
        props0.epoch = true;
        props0.kdf = true;
        props0.salt = true;
        props0.version = true;
      }
    }
  }
  if (!valid0) {
    const err18 = { instancePath, schemaPath: "#/oneOf", keyword: "oneOf", params: { passingSchemas: passing0 }, message: "must match exactly one schema in oneOf" };
    if (vErrors === null) {
      vErrors = [err18];
    } else {
      vErrors.push(err18);
    }
    errors++;
    validate46.errors = vErrors;
    return false;
  } else {
    errors = _errs0;
    if (vErrors !== null) {
      if (_errs0) {
        vErrors.length = _errs0;
      } else {
        vErrors = null;
      }
    }
  }
  validate46.errors = vErrors;
  evaluated0.props = props0;
  return errors === 0;
}
validate46.evaluated = { "dynamicProps": true, "dynamicItems": false };
var isCredentialParamsRequest = validate47;
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
      if (data.identifier === void 0 && (missing0 = "identifier")) {
        validate47.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.identifier !== void 0) {
          if (typeof data.identifier !== "string") {
            validate47.errors = [{ instancePath: instancePath + "/identifier", schemaPath: "#/properties/identifier/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
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
validate47.evaluated = { "props": { "identifier": true }, "dynamicProps": false, "dynamicItems": false };
var isCredentialRegister = validate48;
var schema65 = { "$defs": { "IdentityProof": { "description": "A signature over a server challenge, proving possession of the identity key.", "properties": { "nonce": { "description": "The nonce `/auth/challenge` issued.", "type": "string" }, "signature": { "description": 'hex Ed25519 signature over\n`"<purpose>:" + nonce + ":" + timestamp + ":" + origin`, where purpose is\n`paracord/credential/v2/register` or `paracord/credential/v2/reset`.', "type": "string" }, "timestamp": { "description": "The timestamp `/auth/challenge` issued (Unix seconds).", "format": "int64", "type": "integer" } }, "required": ["nonce", "timestamp", "signature"], "type": "object" }, "KdfParams": { "description": 'scrypt parameters as sent on the wire. Stored per credential as\n`"scrypt:<log_n>:<r>:<p>"` (see [`KdfParams::to_db_text`]).', "properties": { "alg": { "description": 'Always `"scrypt"`.', "type": "string" }, "log_n": { "description": "log2 of scrypt's N.", "format": "uint8", "maximum": 255, "minimum": 0, "type": "integer" }, "p": { "format": "uint32", "minimum": 0, "type": "integer" }, "r": { "format": "uint32", "minimum": 0, "type": "integer" } }, "required": ["alg", "log_n", "r", "p"], "type": "object" }, "NewCredential": { "description": "A freshly derived credential: what the server stores in place of a password.", "properties": { "auth_key": { "description": "b64url of the 32-byte HKDF output `paracord/credential/v2/auth`.", "type": "string" }, "kdf": { "$ref": "#/$defs/KdfParams" }, "salt": { "description": "b64url of 32 random bytes.", "type": "string" } }, "required": ["salt", "kdf", "auth_key"], "type": "object" }, "NewIdentity": { "description": "The identity as the server keeps it: the public key and the private key\nwrapped under the password-derived wrap key.", "properties": { "proof": { "$ref": "#/$defs/IdentityProof" }, "public_key": { "description": "hex of the 32-byte Ed25519 public key.", "type": "string" }, "wrap_alg": { "description": '`"aes256gcm-v2"` ([`WRAP_ALG_V2`]).', "type": "string" }, "wrapped_key": { "description": "b64url of `iv12 || ciphertext+tag` (12 + 48 bytes).", "type": "string" } }, "required": ["public_key", "wrapped_key", "wrap_alg", "proof"], "type": "object" } }, "$id": "urn:paracord:contract:CredentialRegister", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "`POST /api/v1/auth/credential/register`.", "properties": { "credential": { "$ref": "#/$defs/NewCredential" }, "display_name": { "default": null, "type": ["string", "null"] }, "email": { "default": null, "type": ["string", "null"] }, "identity": { "$ref": "#/$defs/NewIdentity" }, "invite_code": { "default": null, "type": ["string", "null"] }, "username": { "type": "string" } }, "required": ["username", "credential", "identity"], "title": "CredentialRegister", "type": "object" };
function validate49(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
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
      let missing0;
      if (data.salt === void 0 && (missing0 = "salt") || data.kdf === void 0 && (missing0 = "kdf") || data.auth_key === void 0 && (missing0 = "auth_key")) {
        validate49.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.auth_key !== void 0) {
          const _errs1 = errors;
          if (typeof data.auth_key !== "string") {
            validate49.errors = [{ instancePath: instancePath + "/auth_key", schemaPath: "#/properties/auth_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.kdf !== void 0) {
            let data1 = data.kdf;
            const _errs3 = errors;
            const _errs4 = errors;
            if (errors === _errs4) {
              if (data1 && typeof data1 == "object" && !Array.isArray(data1)) {
                let missing1;
                if (data1.alg === void 0 && (missing1 = "alg") || data1.log_n === void 0 && (missing1 = "log_n") || data1.r === void 0 && (missing1 = "r") || data1.p === void 0 && (missing1 = "p")) {
                  validate49.errors = [{ instancePath: instancePath + "/kdf", schemaPath: "#/$defs/KdfParams/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                  return false;
                } else {
                  if (data1.alg !== void 0) {
                    const _errs6 = errors;
                    if (typeof data1.alg !== "string") {
                      validate49.errors = [{ instancePath: instancePath + "/kdf/alg", schemaPath: "#/$defs/KdfParams/properties/alg/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid2 = _errs6 === errors;
                  } else {
                    var valid2 = true;
                  }
                  if (valid2) {
                    if (data1.log_n !== void 0) {
                      let data3 = data1.log_n;
                      const _errs8 = errors;
                      if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3))) {
                        validate49.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      if (errors === _errs8) {
                        if (typeof data3 == "number" && isFinite(data3)) {
                          if (data3 > 255 || isNaN(data3)) {
                            validate49.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/maximum", keyword: "maximum", params: { comparison: "<=", limit: 255 }, message: "must be <= 255" }];
                            return false;
                          } else {
                            if (data3 < 0 || isNaN(data3)) {
                              validate49.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                              return false;
                            }
                          }
                        }
                      }
                      var valid2 = _errs8 === errors;
                    } else {
                      var valid2 = true;
                    }
                    if (valid2) {
                      if (data1.p !== void 0) {
                        let data4 = data1.p;
                        const _errs10 = errors;
                        if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
                          validate49.errors = [{ instancePath: instancePath + "/kdf/p", schemaPath: "#/$defs/KdfParams/properties/p/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                          return false;
                        }
                        if (errors === _errs10) {
                          if (typeof data4 == "number" && isFinite(data4)) {
                            if (data4 < 0 || isNaN(data4)) {
                              validate49.errors = [{ instancePath: instancePath + "/kdf/p", schemaPath: "#/$defs/KdfParams/properties/p/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                              return false;
                            }
                          }
                        }
                        var valid2 = _errs10 === errors;
                      } else {
                        var valid2 = true;
                      }
                      if (valid2) {
                        if (data1.r !== void 0) {
                          let data5 = data1.r;
                          const _errs12 = errors;
                          if (!(typeof data5 == "number" && (!(data5 % 1) && !isNaN(data5)) && isFinite(data5))) {
                            validate49.errors = [{ instancePath: instancePath + "/kdf/r", schemaPath: "#/$defs/KdfParams/properties/r/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                            return false;
                          }
                          if (errors === _errs12) {
                            if (typeof data5 == "number" && isFinite(data5)) {
                              if (data5 < 0 || isNaN(data5)) {
                                validate49.errors = [{ instancePath: instancePath + "/kdf/r", schemaPath: "#/$defs/KdfParams/properties/r/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                return false;
                              }
                            }
                          }
                          var valid2 = _errs12 === errors;
                        } else {
                          var valid2 = true;
                        }
                      }
                    }
                  }
                }
              } else {
                validate49.errors = [{ instancePath: instancePath + "/kdf", schemaPath: "#/$defs/KdfParams/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                return false;
              }
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.salt !== void 0) {
              const _errs14 = errors;
              if (typeof data.salt !== "string") {
                validate49.errors = [{ instancePath: instancePath + "/salt", schemaPath: "#/properties/salt/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              var valid0 = _errs14 === errors;
            } else {
              var valid0 = true;
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
validate49.evaluated = { "props": { "auth_key": true, "kdf": true, "salt": true }, "dynamicProps": false, "dynamicItems": false };
function validate51(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
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
      let missing0;
      if (data.public_key === void 0 && (missing0 = "public_key") || data.wrapped_key === void 0 && (missing0 = "wrapped_key") || data.wrap_alg === void 0 && (missing0 = "wrap_alg") || data.proof === void 0 && (missing0 = "proof")) {
        validate51.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.proof !== void 0) {
          let data0 = data.proof;
          const _errs1 = errors;
          const _errs2 = errors;
          if (errors === _errs2) {
            if (data0 && typeof data0 == "object" && !Array.isArray(data0)) {
              let missing1;
              if (data0.nonce === void 0 && (missing1 = "nonce") || data0.timestamp === void 0 && (missing1 = "timestamp") || data0.signature === void 0 && (missing1 = "signature")) {
                validate51.errors = [{ instancePath: instancePath + "/proof", schemaPath: "#/$defs/IdentityProof/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                return false;
              } else {
                if (data0.nonce !== void 0) {
                  const _errs4 = errors;
                  if (typeof data0.nonce !== "string") {
                    validate51.errors = [{ instancePath: instancePath + "/proof/nonce", schemaPath: "#/$defs/IdentityProof/properties/nonce/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                  var valid2 = _errs4 === errors;
                } else {
                  var valid2 = true;
                }
                if (valid2) {
                  if (data0.signature !== void 0) {
                    const _errs6 = errors;
                    if (typeof data0.signature !== "string") {
                      validate51.errors = [{ instancePath: instancePath + "/proof/signature", schemaPath: "#/$defs/IdentityProof/properties/signature/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid2 = _errs6 === errors;
                  } else {
                    var valid2 = true;
                  }
                  if (valid2) {
                    if (data0.timestamp !== void 0) {
                      let data3 = data0.timestamp;
                      const _errs8 = errors;
                      if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3))) {
                        validate51.errors = [{ instancePath: instancePath + "/proof/timestamp", schemaPath: "#/$defs/IdentityProof/properties/timestamp/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      var valid2 = _errs8 === errors;
                    } else {
                      var valid2 = true;
                    }
                  }
                }
              }
            } else {
              validate51.errors = [{ instancePath: instancePath + "/proof", schemaPath: "#/$defs/IdentityProof/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
              return false;
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.public_key !== void 0) {
            const _errs10 = errors;
            if (typeof data.public_key !== "string") {
              validate51.errors = [{ instancePath: instancePath + "/public_key", schemaPath: "#/properties/public_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs10 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.wrap_alg !== void 0) {
              const _errs12 = errors;
              if (typeof data.wrap_alg !== "string") {
                validate51.errors = [{ instancePath: instancePath + "/wrap_alg", schemaPath: "#/properties/wrap_alg/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              var valid0 = _errs12 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.wrapped_key !== void 0) {
                const _errs14 = errors;
                if (typeof data.wrapped_key !== "string") {
                  validate51.errors = [{ instancePath: instancePath + "/wrapped_key", schemaPath: "#/properties/wrapped_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid0 = _errs14 === errors;
              } else {
                var valid0 = true;
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
validate51.evaluated = { "props": { "proof": true, "public_key": true, "wrap_alg": true, "wrapped_key": true }, "dynamicProps": false, "dynamicItems": false };
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
      if (data.username === void 0 && (missing0 = "username") || data.credential === void 0 && (missing0 = "credential") || data.identity === void 0 && (missing0 = "identity")) {
        validate48.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.credential !== void 0) {
          const _errs1 = errors;
          if (!validate49(data.credential, { instancePath: instancePath + "/credential", parentData: data, parentDataProperty: "credential", rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate49.errors : vErrors.concat(validate49.errors);
            errors = vErrors.length;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.display_name !== void 0) {
            let data1 = data.display_name;
            const _errs2 = errors;
            if (typeof data1 !== "string" && data1 !== null) {
              validate48.errors = [{ instancePath: instancePath + "/display_name", schemaPath: "#/properties/display_name/type", keyword: "type", params: { type: schema65.properties.display_name.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs2 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.email !== void 0) {
              let data2 = data.email;
              const _errs4 = errors;
              if (typeof data2 !== "string" && data2 !== null) {
                validate48.errors = [{ instancePath: instancePath + "/email", schemaPath: "#/properties/email/type", keyword: "type", params: { type: schema65.properties.email.type }, message: "must be string,null" }];
                return false;
              }
              var valid0 = _errs4 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.identity !== void 0) {
                const _errs6 = errors;
                if (!validate51(data.identity, { instancePath: instancePath + "/identity", parentData: data, parentDataProperty: "identity", rootData, dynamicAnchors })) {
                  vErrors = vErrors === null ? validate51.errors : vErrors.concat(validate51.errors);
                  errors = vErrors.length;
                }
                var valid0 = _errs6 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.invite_code !== void 0) {
                  let data4 = data.invite_code;
                  const _errs7 = errors;
                  if (typeof data4 !== "string" && data4 !== null) {
                    validate48.errors = [{ instancePath: instancePath + "/invite_code", schemaPath: "#/properties/invite_code/type", keyword: "type", params: { type: schema65.properties.invite_code.type }, message: "must be string,null" }];
                    return false;
                  }
                  var valid0 = _errs7 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.username !== void 0) {
                    const _errs9 = errors;
                    if (typeof data.username !== "string") {
                      validate48.errors = [{ instancePath: instancePath + "/username", schemaPath: "#/properties/username/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid0 = _errs9 === errors;
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
      validate48.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate48.errors = vErrors;
  return errors === 0;
}
validate48.evaluated = { "props": { "credential": true, "display_name": true, "email": true, "identity": true, "invite_code": true, "username": true }, "dynamicProps": false, "dynamicItems": false };
var isCredentialUpgradeRequest = validate53;
function validate54(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate54.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.salt === void 0 && (missing0 = "salt") || data.kdf === void 0 && (missing0 = "kdf") || data.auth_key === void 0 && (missing0 = "auth_key")) {
        validate54.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.auth_key !== void 0) {
          const _errs1 = errors;
          if (typeof data.auth_key !== "string") {
            validate54.errors = [{ instancePath: instancePath + "/auth_key", schemaPath: "#/properties/auth_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.kdf !== void 0) {
            let data1 = data.kdf;
            const _errs3 = errors;
            const _errs4 = errors;
            if (errors === _errs4) {
              if (data1 && typeof data1 == "object" && !Array.isArray(data1)) {
                let missing1;
                if (data1.alg === void 0 && (missing1 = "alg") || data1.log_n === void 0 && (missing1 = "log_n") || data1.r === void 0 && (missing1 = "r") || data1.p === void 0 && (missing1 = "p")) {
                  validate54.errors = [{ instancePath: instancePath + "/kdf", schemaPath: "#/$defs/KdfParams/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                  return false;
                } else {
                  if (data1.alg !== void 0) {
                    const _errs6 = errors;
                    if (typeof data1.alg !== "string") {
                      validate54.errors = [{ instancePath: instancePath + "/kdf/alg", schemaPath: "#/$defs/KdfParams/properties/alg/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid2 = _errs6 === errors;
                  } else {
                    var valid2 = true;
                  }
                  if (valid2) {
                    if (data1.log_n !== void 0) {
                      let data3 = data1.log_n;
                      const _errs8 = errors;
                      if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3))) {
                        validate54.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      if (errors === _errs8) {
                        if (typeof data3 == "number" && isFinite(data3)) {
                          if (data3 > 255 || isNaN(data3)) {
                            validate54.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/maximum", keyword: "maximum", params: { comparison: "<=", limit: 255 }, message: "must be <= 255" }];
                            return false;
                          } else {
                            if (data3 < 0 || isNaN(data3)) {
                              validate54.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                              return false;
                            }
                          }
                        }
                      }
                      var valid2 = _errs8 === errors;
                    } else {
                      var valid2 = true;
                    }
                    if (valid2) {
                      if (data1.p !== void 0) {
                        let data4 = data1.p;
                        const _errs10 = errors;
                        if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
                          validate54.errors = [{ instancePath: instancePath + "/kdf/p", schemaPath: "#/$defs/KdfParams/properties/p/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                          return false;
                        }
                        if (errors === _errs10) {
                          if (typeof data4 == "number" && isFinite(data4)) {
                            if (data4 < 0 || isNaN(data4)) {
                              validate54.errors = [{ instancePath: instancePath + "/kdf/p", schemaPath: "#/$defs/KdfParams/properties/p/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                              return false;
                            }
                          }
                        }
                        var valid2 = _errs10 === errors;
                      } else {
                        var valid2 = true;
                      }
                      if (valid2) {
                        if (data1.r !== void 0) {
                          let data5 = data1.r;
                          const _errs12 = errors;
                          if (!(typeof data5 == "number" && (!(data5 % 1) && !isNaN(data5)) && isFinite(data5))) {
                            validate54.errors = [{ instancePath: instancePath + "/kdf/r", schemaPath: "#/$defs/KdfParams/properties/r/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                            return false;
                          }
                          if (errors === _errs12) {
                            if (typeof data5 == "number" && isFinite(data5)) {
                              if (data5 < 0 || isNaN(data5)) {
                                validate54.errors = [{ instancePath: instancePath + "/kdf/r", schemaPath: "#/$defs/KdfParams/properties/r/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                return false;
                              }
                            }
                          }
                          var valid2 = _errs12 === errors;
                        } else {
                          var valid2 = true;
                        }
                      }
                    }
                  }
                }
              } else {
                validate54.errors = [{ instancePath: instancePath + "/kdf", schemaPath: "#/$defs/KdfParams/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                return false;
              }
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.salt !== void 0) {
              const _errs14 = errors;
              if (typeof data.salt !== "string") {
                validate54.errors = [{ instancePath: instancePath + "/salt", schemaPath: "#/properties/salt/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              var valid0 = _errs14 === errors;
            } else {
              var valid0 = true;
            }
          }
        }
      }
    } else {
      validate54.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate54.errors = vErrors;
  return errors === 0;
}
validate54.evaluated = { "props": { "auth_key": true, "kdf": true, "salt": true }, "dynamicProps": false, "dynamicItems": false };
function validate56(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate56.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.public_key === void 0 && (missing0 = "public_key") || data.wrapped_key === void 0 && (missing0 = "wrapped_key") || data.wrap_alg === void 0 && (missing0 = "wrap_alg") || data.proof === void 0 && (missing0 = "proof")) {
        validate56.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.proof !== void 0) {
          let data0 = data.proof;
          const _errs1 = errors;
          const _errs2 = errors;
          if (errors === _errs2) {
            if (data0 && typeof data0 == "object" && !Array.isArray(data0)) {
              let missing1;
              if (data0.nonce === void 0 && (missing1 = "nonce") || data0.timestamp === void 0 && (missing1 = "timestamp") || data0.signature === void 0 && (missing1 = "signature")) {
                validate56.errors = [{ instancePath: instancePath + "/proof", schemaPath: "#/$defs/IdentityProof/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                return false;
              } else {
                if (data0.nonce !== void 0) {
                  const _errs4 = errors;
                  if (typeof data0.nonce !== "string") {
                    validate56.errors = [{ instancePath: instancePath + "/proof/nonce", schemaPath: "#/$defs/IdentityProof/properties/nonce/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                  var valid2 = _errs4 === errors;
                } else {
                  var valid2 = true;
                }
                if (valid2) {
                  if (data0.signature !== void 0) {
                    const _errs6 = errors;
                    if (typeof data0.signature !== "string") {
                      validate56.errors = [{ instancePath: instancePath + "/proof/signature", schemaPath: "#/$defs/IdentityProof/properties/signature/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid2 = _errs6 === errors;
                  } else {
                    var valid2 = true;
                  }
                  if (valid2) {
                    if (data0.timestamp !== void 0) {
                      let data3 = data0.timestamp;
                      const _errs8 = errors;
                      if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3))) {
                        validate56.errors = [{ instancePath: instancePath + "/proof/timestamp", schemaPath: "#/$defs/IdentityProof/properties/timestamp/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      var valid2 = _errs8 === errors;
                    } else {
                      var valid2 = true;
                    }
                  }
                }
              }
            } else {
              validate56.errors = [{ instancePath: instancePath + "/proof", schemaPath: "#/$defs/IdentityProof/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
              return false;
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.public_key !== void 0) {
            const _errs10 = errors;
            if (typeof data.public_key !== "string") {
              validate56.errors = [{ instancePath: instancePath + "/public_key", schemaPath: "#/properties/public_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs10 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.wrap_alg !== void 0) {
              const _errs12 = errors;
              if (typeof data.wrap_alg !== "string") {
                validate56.errors = [{ instancePath: instancePath + "/wrap_alg", schemaPath: "#/properties/wrap_alg/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              var valid0 = _errs12 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.wrapped_key !== void 0) {
                const _errs14 = errors;
                if (typeof data.wrapped_key !== "string") {
                  validate56.errors = [{ instancePath: instancePath + "/wrapped_key", schemaPath: "#/properties/wrapped_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid0 = _errs14 === errors;
              } else {
                var valid0 = true;
              }
            }
          }
        }
      }
    } else {
      validate56.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate56.errors = vErrors;
  return errors === 0;
}
validate56.evaluated = { "props": { "proof": true, "public_key": true, "wrap_alg": true, "wrapped_key": true }, "dynamicProps": false, "dynamicItems": false };
function validate53(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate53.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.current_password === void 0 && (missing0 = "current_password") || data.credential === void 0 && (missing0 = "credential") || data.identity === void 0 && (missing0 = "identity")) {
        validate53.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.credential !== void 0) {
          const _errs1 = errors;
          if (!validate54(data.credential, { instancePath: instancePath + "/credential", parentData: data, parentDataProperty: "credential", rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate54.errors : vErrors.concat(validate54.errors);
            errors = vErrors.length;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.current_password !== void 0) {
            const _errs2 = errors;
            if (typeof data.current_password !== "string") {
              validate53.errors = [{ instancePath: instancePath + "/current_password", schemaPath: "#/properties/current_password/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs2 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.identity !== void 0) {
              const _errs4 = errors;
              if (!validate56(data.identity, { instancePath: instancePath + "/identity", parentData: data, parentDataProperty: "identity", rootData, dynamicAnchors })) {
                vErrors = vErrors === null ? validate56.errors : vErrors.concat(validate56.errors);
                errors = vErrors.length;
              }
              var valid0 = _errs4 === errors;
            } else {
              var valid0 = true;
            }
          }
        }
      }
    } else {
      validate53.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate53.errors = vErrors;
  return errors === 0;
}
validate53.evaluated = { "props": { "credential": true, "current_password": true, "identity": true }, "dynamicProps": false, "dynamicItems": false };
var isCurrentUser = validate58;
var schema75 = { "$defs": { "LinkedAccount": { "description": "A linked account published on a user's public profile.", "properties": { "label": { "type": "string" }, "url": { "type": "string" } }, "required": ["label", "url"], "type": "object" } }, "$id": "urn:paracord:contract:CurrentUser", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "`GET /users/@me`: the authenticated account, including credential metadata.", "properties": { "accent_color": { "description": "Profile accent as `0xRRGGBB`. Omitted when the member has not chosen one.\n\nNew in 3.2. Unlike the other nullable fields it may be absent rather\nthan null, so a 3.2 client can still read accounts from a 3.1 instance,\nwhich never sends it.", "format": "int32", "type": ["integer", "null"] }, "avatar_hash": { "type": ["string", "null"] }, "banner_hash": { "type": ["string", "null"] }, "bio": { "type": ["string", "null"] }, "bot": { "type": "boolean" }, "created_at": { "type": "string" }, "discriminator": { "format": "int32", "type": "integer" }, "display_name": { "type": ["string", "null"] }, "email": { "type": "string" }, "email_verified": { "type": "boolean" }, "flags": { "format": "int32", "type": "integer" }, "has_public_key": { "type": "boolean" }, "id": { "type": "string" }, "linked_accounts": { "items": { "$ref": "#/$defs/LinkedAccount" }, "type": "array" }, "pronouns": { "type": ["string", "null"] }, "public_key": { "description": "An attached Ed25519 key can authenticate this account on its own, so the\nowner must be able to see that one exists and which one it is.", "type": ["string", "null"] }, "system": { "type": "boolean" }, "username": { "type": "string" } }, "required": ["id", "username", "discriminator", "display_name", "avatar_hash", "banner_hash", "bio", "flags", "bot", "system", "created_at", "pronouns", "linked_accounts", "email", "email_verified", "public_key", "has_public_key"], "title": "CurrentUser", "type": "object" };
function validate58(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate58.evaluated;
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
        validate58.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.accent_color !== void 0) {
          let data0 = data.accent_color;
          const _errs1 = errors;
          if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)) && isFinite(data0)) && data0 !== null) {
            validate58.errors = [{ instancePath: instancePath + "/accent_color", schemaPath: "#/properties/accent_color/type", keyword: "type", params: { type: schema75.properties.accent_color.type }, message: "must be integer,null" }];
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
              validate58.errors = [{ instancePath: instancePath + "/avatar_hash", schemaPath: "#/properties/avatar_hash/type", keyword: "type", params: { type: schema75.properties.avatar_hash.type }, message: "must be string,null" }];
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
                validate58.errors = [{ instancePath: instancePath + "/banner_hash", schemaPath: "#/properties/banner_hash/type", keyword: "type", params: { type: schema75.properties.banner_hash.type }, message: "must be string,null" }];
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
                  validate58.errors = [{ instancePath: instancePath + "/bio", schemaPath: "#/properties/bio/type", keyword: "type", params: { type: schema75.properties.bio.type }, message: "must be string,null" }];
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
                    validate58.errors = [{ instancePath: instancePath + "/bot", schemaPath: "#/properties/bot/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
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
                      validate58.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                        validate58.errors = [{ instancePath: instancePath + "/discriminator", schemaPath: "#/properties/discriminator/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
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
                          validate58.errors = [{ instancePath: instancePath + "/display_name", schemaPath: "#/properties/display_name/type", keyword: "type", params: { type: schema75.properties.display_name.type }, message: "must be string,null" }];
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
                            validate58.errors = [{ instancePath: instancePath + "/email", schemaPath: "#/properties/email/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                              validate58.errors = [{ instancePath: instancePath + "/email_verified", schemaPath: "#/properties/email_verified/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
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
                                validate58.errors = [{ instancePath: instancePath + "/flags", schemaPath: "#/properties/flags/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
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
                                  validate58.errors = [{ instancePath: instancePath + "/has_public_key", schemaPath: "#/properties/has_public_key/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
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
                                    validate58.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                                validate58.errors = [{ instancePath: instancePath + "/linked_accounts/" + i0, schemaPath: "#/$defs/LinkedAccount/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                                                return false;
                                              } else {
                                                if (data14.label !== void 0) {
                                                  const _errs32 = errors;
                                                  if (typeof data14.label !== "string") {
                                                    validate58.errors = [{ instancePath: instancePath + "/linked_accounts/" + i0 + "/label", schemaPath: "#/$defs/LinkedAccount/properties/label/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                                      validate58.errors = [{ instancePath: instancePath + "/linked_accounts/" + i0 + "/url", schemaPath: "#/$defs/LinkedAccount/properties/url/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                                      return false;
                                                    }
                                                    var valid3 = _errs34 === errors;
                                                  } else {
                                                    var valid3 = true;
                                                  }
                                                }
                                              }
                                            } else {
                                              validate58.errors = [{ instancePath: instancePath + "/linked_accounts/" + i0, schemaPath: "#/$defs/LinkedAccount/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                                              return false;
                                            }
                                          }
                                          var valid1 = _errs29 === errors;
                                          if (!valid1) {
                                            break;
                                          }
                                        }
                                      } else {
                                        validate58.errors = [{ instancePath: instancePath + "/linked_accounts", schemaPath: "#/properties/linked_accounts/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
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
                                        validate58.errors = [{ instancePath: instancePath + "/pronouns", schemaPath: "#/properties/pronouns/type", keyword: "type", params: { type: schema75.properties.pronouns.type }, message: "must be string,null" }];
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
                                          validate58.errors = [{ instancePath: instancePath + "/public_key", schemaPath: "#/properties/public_key/type", keyword: "type", params: { type: schema75.properties.public_key.type }, message: "must be string,null" }];
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
                                            validate58.errors = [{ instancePath: instancePath + "/system", schemaPath: "#/properties/system/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
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
                                              validate58.errors = [{ instancePath: instancePath + "/username", schemaPath: "#/properties/username/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
      validate58.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate58.errors = vErrors;
  return errors === 0;
}
validate58.evaluated = { "props": { "accent_color": true, "avatar_hash": true, "banner_hash": true, "bio": true, "bot": true, "created_at": true, "discriminator": true, "display_name": true, "email": true, "email_verified": true, "flags": true, "has_public_key": true, "id": true, "linked_accounts": true, "pronouns": true, "public_key": true, "system": true, "username": true }, "dynamicProps": false, "dynamicItems": false };
var isGuildDetail = validate59;
var schema77 = { "$defs": { "GuildBotConfig": { "additionalProperties": true, "properties": { "enabled": { "type": ["boolean", "null"] } }, "type": "object" }, "GuildVisibility": { "enum": ["private", "public", "roles"], "type": "string" }, "HubSettings": { "additionalProperties": true, "properties": { "description": { "type": ["string", "null"] }, "pinned_channels": { "items": { "type": "string" }, "type": ["array", "null"] }, "welcome_text": { "type": ["string", "null"] } }, "type": "object" } }, "$id": "urn:paracord:contract:GuildDetail", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "Full settings returned by the space detail and mutation endpoints.", "properties": { "allowed_roles": { "items": { "type": "string" }, "type": "array" }, "banner_hash": { "default": null, "description": "`/api/v1/guilds/{id}/banner?v=\u2026` once a banner is uploaded, otherwise null.\nThe version changes with every upload. This server always sends it; it\nis optional in the contract because servers older than 3.2 (no banners)\nleave it out of the summary, and absent reads exactly as null.", "type": ["string", "null"] }, "bot_settings": { "additionalProperties": { "$ref": "#/$defs/GuildBotConfig" }, "type": ["object", "null"] }, "created_at": { "type": "string" }, "description": { "type": ["string", "null"] }, "discovery_tags": { "items": { "type": "string" }, "type": "array" }, "feature_flags": { "description": "The persisted feature bitset; it is not an array of feature names.", "format": "int32", "maximum": 2147483647, "minimum": -2147483648, "type": "integer" }, "hub_settings": { "anyOf": [{ "$ref": "#/$defs/HubSettings" }, { "type": "null" }] }, "hue": { "default": null, "description": `The server's color as a hue, 0-359. Null when unset; clients then
derive one from the id. This server always sends it. It is optional in
the contract for protocol-version tolerance: a server from before
server colors leaves it out, which a client reads as null (no color
picked) and as "this server cannot store a color".`, "format": "uint32", "maximum": 359, "minimum": 0, "type": ["integer", "null"] }, "icon_hash": { "type": ["string", "null"] }, "id": { "type": "string" }, "member_count": { "format": "uint32", "maximum": 4294967295, "minimum": 0, "type": "integer" }, "name": { "type": "string" }, "owner_id": { "type": "string" }, "system_channel_id": { "type": ["string", "null"] }, "vanity_url_code": { "type": ["string", "null"] }, "visibility": { "$ref": "#/$defs/GuildVisibility" } }, "required": ["id", "name", "description", "icon_hash", "owner_id", "member_count", "created_at", "visibility", "allowed_roles", "discovery_tags", "hub_settings", "bot_settings", "system_channel_id", "vanity_url_code", "feature_flags"], "title": "GuildDetail", "type": "object" };
var schema78 = { "additionalProperties": true, "properties": { "enabled": { "type": ["boolean", "null"] } }, "type": "object" };
var schema79 = { "additionalProperties": true, "properties": { "description": { "type": ["string", "null"] }, "pinned_channels": { "items": { "type": "string" }, "type": ["array", "null"] }, "welcome_text": { "type": ["string", "null"] } }, "type": "object" };
var schema80 = { "enum": ["private", "public", "roles"], "type": "string" };
function validate59(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate59.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.id === void 0 && (missing0 = "id") || data.name === void 0 && (missing0 = "name") || data.description === void 0 && (missing0 = "description") || data.icon_hash === void 0 && (missing0 = "icon_hash") || data.owner_id === void 0 && (missing0 = "owner_id") || data.member_count === void 0 && (missing0 = "member_count") || data.created_at === void 0 && (missing0 = "created_at") || data.visibility === void 0 && (missing0 = "visibility") || data.allowed_roles === void 0 && (missing0 = "allowed_roles") || data.discovery_tags === void 0 && (missing0 = "discovery_tags") || data.hub_settings === void 0 && (missing0 = "hub_settings") || data.bot_settings === void 0 && (missing0 = "bot_settings") || data.system_channel_id === void 0 && (missing0 = "system_channel_id") || data.vanity_url_code === void 0 && (missing0 = "vanity_url_code") || data.feature_flags === void 0 && (missing0 = "feature_flags")) {
        validate59.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
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
                  validate59.errors = [{ instancePath: instancePath + "/allowed_roles/" + i0, schemaPath: "#/properties/allowed_roles/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid1 = _errs3 === errors;
                if (!valid1) {
                  break;
                }
              }
            } else {
              validate59.errors = [{ instancePath: instancePath + "/allowed_roles", schemaPath: "#/properties/allowed_roles/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
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
              validate59.errors = [{ instancePath: instancePath + "/banner_hash", schemaPath: "#/properties/banner_hash/type", keyword: "type", params: { type: schema77.properties.banner_hash.type }, message: "must be string,null" }];
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
                validate59.errors = [{ instancePath: instancePath + "/bot_settings", schemaPath: "#/properties/bot_settings/type", keyword: "type", params: { type: schema77.properties.bot_settings.type }, message: "must be object,null" }];
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
                            validate59.errors = [{ instancePath: instancePath + "/bot_settings/" + key0.replace(/~/g, "~0").replace(/\//g, "~1") + "/enabled", schemaPath: "#/$defs/GuildBotConfig/properties/enabled/type", keyword: "type", params: { type: schema78.properties.enabled.type }, message: "must be boolean,null" }];
                            return false;
                          }
                        }
                      } else {
                        validate59.errors = [{ instancePath: instancePath + "/bot_settings/" + key0.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/$defs/GuildBotConfig/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
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
                  validate59.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                    validate59.errors = [{ instancePath: instancePath + "/description", schemaPath: "#/properties/description/type", keyword: "type", params: { type: schema77.properties.description.type }, message: "must be string,null" }];
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
                            validate59.errors = [{ instancePath: instancePath + "/discovery_tags/" + i1, schemaPath: "#/properties/discovery_tags/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                            return false;
                          }
                          var valid5 = _errs22 === errors;
                          if (!valid5) {
                            break;
                          }
                        }
                      } else {
                        validate59.errors = [{ instancePath: instancePath + "/discovery_tags", schemaPath: "#/properties/discovery_tags/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
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
                        validate59.errors = [{ instancePath: instancePath + "/feature_flags", schemaPath: "#/properties/feature_flags/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      if (errors === _errs24) {
                        if (typeof data10 == "number" && isFinite(data10)) {
                          if (data10 > 2147483647 || isNaN(data10)) {
                            validate59.errors = [{ instancePath: instancePath + "/feature_flags", schemaPath: "#/properties/feature_flags/maximum", keyword: "maximum", params: { comparison: "<=", limit: 2147483647 }, message: "must be <= 2147483647" }];
                            return false;
                          } else {
                            if (data10 < -2147483648 || isNaN(data10)) {
                              validate59.errors = [{ instancePath: instancePath + "/feature_flags", schemaPath: "#/properties/feature_flags/minimum", keyword: "minimum", params: { comparison: ">=", limit: -2147483648 }, message: "must be >= -2147483648" }];
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
                                const err0 = { instancePath: instancePath + "/hub_settings/description", schemaPath: "#/$defs/HubSettings/properties/description/type", keyword: "type", params: { type: schema79.properties.description.type }, message: "must be string,null" };
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
                                  const err1 = { instancePath: instancePath + "/hub_settings/pinned_channels", schemaPath: "#/$defs/HubSettings/properties/pinned_channels/type", keyword: "type", params: { type: schema79.properties.pinned_channels.type }, message: "must be array,null" };
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
                                    const err3 = { instancePath: instancePath + "/hub_settings/welcome_text", schemaPath: "#/$defs/HubSettings/properties/welcome_text/type", keyword: "type", params: { type: schema79.properties.welcome_text.type }, message: "must be string,null" };
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
                          validate59.errors = vErrors;
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
                        if (data.hue !== void 0) {
                          let data16 = data.hue;
                          const _errs42 = errors;
                          if (!(typeof data16 == "number" && (!(data16 % 1) && !isNaN(data16)) && isFinite(data16)) && data16 !== null) {
                            validate59.errors = [{ instancePath: instancePath + "/hue", schemaPath: "#/properties/hue/type", keyword: "type", params: { type: schema77.properties.hue.type }, message: "must be integer,null" }];
                            return false;
                          }
                          if (errors === _errs42) {
                            if (typeof data16 == "number" && isFinite(data16)) {
                              if (data16 > 359 || isNaN(data16)) {
                                validate59.errors = [{ instancePath: instancePath + "/hue", schemaPath: "#/properties/hue/maximum", keyword: "maximum", params: { comparison: "<=", limit: 359 }, message: "must be <= 359" }];
                                return false;
                              } else {
                                if (data16 < 0 || isNaN(data16)) {
                                  validate59.errors = [{ instancePath: instancePath + "/hue", schemaPath: "#/properties/hue/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                  return false;
                                }
                              }
                            }
                          }
                          var valid0 = _errs42 === errors;
                        } else {
                          var valid0 = true;
                        }
                        if (valid0) {
                          if (data.icon_hash !== void 0) {
                            let data17 = data.icon_hash;
                            const _errs44 = errors;
                            if (typeof data17 !== "string" && data17 !== null) {
                              validate59.errors = [{ instancePath: instancePath + "/icon_hash", schemaPath: "#/properties/icon_hash/type", keyword: "type", params: { type: schema77.properties.icon_hash.type }, message: "must be string,null" }];
                              return false;
                            }
                            var valid0 = _errs44 === errors;
                          } else {
                            var valid0 = true;
                          }
                          if (valid0) {
                            if (data.id !== void 0) {
                              const _errs46 = errors;
                              if (typeof data.id !== "string") {
                                validate59.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                return false;
                              }
                              var valid0 = _errs46 === errors;
                            } else {
                              var valid0 = true;
                            }
                            if (valid0) {
                              if (data.member_count !== void 0) {
                                let data19 = data.member_count;
                                const _errs48 = errors;
                                if (!(typeof data19 == "number" && (!(data19 % 1) && !isNaN(data19)) && isFinite(data19))) {
                                  validate59.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                                  return false;
                                }
                                if (errors === _errs48) {
                                  if (typeof data19 == "number" && isFinite(data19)) {
                                    if (data19 > 4294967295 || isNaN(data19)) {
                                      validate59.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" }];
                                      return false;
                                    } else {
                                      if (data19 < 0 || isNaN(data19)) {
                                        validate59.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                        return false;
                                      }
                                    }
                                  }
                                }
                                var valid0 = _errs48 === errors;
                              } else {
                                var valid0 = true;
                              }
                              if (valid0) {
                                if (data.name !== void 0) {
                                  const _errs50 = errors;
                                  if (typeof data.name !== "string") {
                                    validate59.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                    return false;
                                  }
                                  var valid0 = _errs50 === errors;
                                } else {
                                  var valid0 = true;
                                }
                                if (valid0) {
                                  if (data.owner_id !== void 0) {
                                    const _errs52 = errors;
                                    if (typeof data.owner_id !== "string") {
                                      validate59.errors = [{ instancePath: instancePath + "/owner_id", schemaPath: "#/properties/owner_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                      return false;
                                    }
                                    var valid0 = _errs52 === errors;
                                  } else {
                                    var valid0 = true;
                                  }
                                  if (valid0) {
                                    if (data.system_channel_id !== void 0) {
                                      let data22 = data.system_channel_id;
                                      const _errs54 = errors;
                                      if (typeof data22 !== "string" && data22 !== null) {
                                        validate59.errors = [{ instancePath: instancePath + "/system_channel_id", schemaPath: "#/properties/system_channel_id/type", keyword: "type", params: { type: schema77.properties.system_channel_id.type }, message: "must be string,null" }];
                                        return false;
                                      }
                                      var valid0 = _errs54 === errors;
                                    } else {
                                      var valid0 = true;
                                    }
                                    if (valid0) {
                                      if (data.vanity_url_code !== void 0) {
                                        let data23 = data.vanity_url_code;
                                        const _errs56 = errors;
                                        if (typeof data23 !== "string" && data23 !== null) {
                                          validate59.errors = [{ instancePath: instancePath + "/vanity_url_code", schemaPath: "#/properties/vanity_url_code/type", keyword: "type", params: { type: schema77.properties.vanity_url_code.type }, message: "must be string,null" }];
                                          return false;
                                        }
                                        var valid0 = _errs56 === errors;
                                      } else {
                                        var valid0 = true;
                                      }
                                      if (valid0) {
                                        if (data.visibility !== void 0) {
                                          let data24 = data.visibility;
                                          const _errs58 = errors;
                                          if (typeof data24 !== "string") {
                                            validate59.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/$defs/GuildVisibility/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                            return false;
                                          }
                                          if (!(data24 === "private" || data24 === "public" || data24 === "roles")) {
                                            validate59.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/$defs/GuildVisibility/enum", keyword: "enum", params: { allowedValues: schema80.enum }, message: "must be equal to one of the allowed values" }];
                                            return false;
                                          }
                                          var valid0 = _errs58 === errors;
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
    } else {
      validate59.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate59.errors = vErrors;
  return errors === 0;
}
validate59.evaluated = { "props": { "allowed_roles": true, "banner_hash": true, "bot_settings": true, "created_at": true, "description": true, "discovery_tags": true, "feature_flags": true, "hub_settings": true, "hue": true, "icon_hash": true, "id": true, "member_count": true, "name": true, "owner_id": true, "system_channel_id": true, "vanity_url_code": true, "visibility": true }, "dynamicProps": false, "dynamicItems": false };
var isGuildEmoji = validate60;
var schema81 = { "$id": "urn:paracord:contract:GuildEmoji", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "A custom guild emoji. `creator_id` is null for emoji whose creator record\nis gone; the field is always present.", "properties": { "animated": { "type": "boolean" }, "created_at": { "type": "string" }, "creator_id": { "type": ["string", "null"] }, "guild_id": { "type": "string" }, "id": { "type": "string" }, "name": { "type": "string" } }, "required": ["id", "guild_id", "name", "animated", "creator_id", "created_at"], "title": "GuildEmoji", "type": "object" };
function validate60(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate60.evaluated;
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
        validate60.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.animated !== void 0) {
          const _errs1 = errors;
          if (typeof data.animated !== "boolean") {
            validate60.errors = [{ instancePath: instancePath + "/animated", schemaPath: "#/properties/animated/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
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
              validate60.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                validate60.errors = [{ instancePath: instancePath + "/creator_id", schemaPath: "#/properties/creator_id/type", keyword: "type", params: { type: schema81.properties.creator_id.type }, message: "must be string,null" }];
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
                  validate60.errors = [{ instancePath: instancePath + "/guild_id", schemaPath: "#/properties/guild_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                    validate60.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                      validate60.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
      validate60.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate60.errors = vErrors;
  return errors === 0;
}
validate60.evaluated = { "props": { "animated": true, "created_at": true, "creator_id": true, "guild_id": true, "id": true, "name": true }, "dynamicProps": false, "dynamicItems": false };
var isGuildEmojiList = validate61;
var schema83 = { "description": "A custom guild emoji. `creator_id` is null for emoji whose creator record\nis gone; the field is always present.", "properties": { "animated": { "type": "boolean" }, "created_at": { "type": "string" }, "creator_id": { "type": ["string", "null"] }, "guild_id": { "type": "string" }, "id": { "type": "string" }, "name": { "type": "string" } }, "required": ["id", "guild_id", "name", "animated", "creator_id", "created_at"], "type": "object" };
function validate61(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate61.evaluated;
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
              validate61.errors = [{ instancePath: instancePath + "/" + i0, schemaPath: "#/$defs/GuildEmoji/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
              return false;
            } else {
              if (data0.animated !== void 0) {
                const _errs4 = errors;
                if (typeof data0.animated !== "boolean") {
                  validate61.errors = [{ instancePath: instancePath + "/" + i0 + "/animated", schemaPath: "#/$defs/GuildEmoji/properties/animated/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
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
                    validate61.errors = [{ instancePath: instancePath + "/" + i0 + "/created_at", schemaPath: "#/$defs/GuildEmoji/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                      validate61.errors = [{ instancePath: instancePath + "/" + i0 + "/creator_id", schemaPath: "#/$defs/GuildEmoji/properties/creator_id/type", keyword: "type", params: { type: schema83.properties.creator_id.type }, message: "must be string,null" }];
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
                        validate61.errors = [{ instancePath: instancePath + "/" + i0 + "/guild_id", schemaPath: "#/$defs/GuildEmoji/properties/guild_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                          validate61.errors = [{ instancePath: instancePath + "/" + i0 + "/id", schemaPath: "#/$defs/GuildEmoji/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                            validate61.errors = [{ instancePath: instancePath + "/" + i0 + "/name", schemaPath: "#/$defs/GuildEmoji/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
            validate61.errors = [{ instancePath: instancePath + "/" + i0, schemaPath: "#/$defs/GuildEmoji/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
            return false;
          }
        }
        var valid0 = _errs1 === errors;
        if (!valid0) {
          break;
        }
      }
    } else {
      validate61.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
      return false;
    }
  }
  validate61.errors = vErrors;
  return errors === 0;
}
validate61.evaluated = { "items": true, "dynamicProps": false, "dynamicItems": false };
var isGuildInvite = validate62;
var schema84 = { "$id": "urn:paracord:contract:GuildInvite", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "A guild invite as returned by create and guild-scoped list endpoints.\nNullable fields are present in responses, including when their value is null.\n`max_uses`/`max_age` of 0 mean unlimited/never expire.", "properties": { "channel_id": { "type": "string" }, "code": { "type": "string" }, "created_at": { "type": "string" }, "guild_id": { "type": "string" }, "inviter_id": { "type": ["string", "null"] }, "max_age": { "format": "int32", "type": ["integer", "null"] }, "max_uses": { "format": "int32", "type": ["integer", "null"] }, "uses": { "format": "int32", "type": "integer" } }, "required": ["code", "guild_id", "channel_id", "inviter_id", "max_uses", "uses", "max_age", "created_at"], "title": "GuildInvite", "type": "object" };
function validate62(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate62.evaluated;
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
        validate62.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.channel_id !== void 0) {
          const _errs1 = errors;
          if (typeof data.channel_id !== "string") {
            validate62.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
              validate62.errors = [{ instancePath: instancePath + "/code", schemaPath: "#/properties/code/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                validate62.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                  validate62.errors = [{ instancePath: instancePath + "/guild_id", schemaPath: "#/properties/guild_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                    validate62.errors = [{ instancePath: instancePath + "/inviter_id", schemaPath: "#/properties/inviter_id/type", keyword: "type", params: { type: schema84.properties.inviter_id.type }, message: "must be string,null" }];
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
                      validate62.errors = [{ instancePath: instancePath + "/max_age", schemaPath: "#/properties/max_age/type", keyword: "type", params: { type: schema84.properties.max_age.type }, message: "must be integer,null" }];
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
                        validate62.errors = [{ instancePath: instancePath + "/max_uses", schemaPath: "#/properties/max_uses/type", keyword: "type", params: { type: schema84.properties.max_uses.type }, message: "must be integer,null" }];
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
                          validate62.errors = [{ instancePath: instancePath + "/uses", schemaPath: "#/properties/uses/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
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
      validate62.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate62.errors = vErrors;
  return errors === 0;
}
validate62.evaluated = { "props": { "channel_id": true, "code": true, "created_at": true, "guild_id": true, "inviter_id": true, "max_age": true, "max_uses": true, "uses": true }, "dynamicProps": false, "dynamicItems": false };
var isGuildInviteList = validate63;
var schema86 = { "description": "A guild invite as returned by create and guild-scoped list endpoints.\nNullable fields are present in responses, including when their value is null.\n`max_uses`/`max_age` of 0 mean unlimited/never expire.", "properties": { "channel_id": { "type": "string" }, "code": { "type": "string" }, "created_at": { "type": "string" }, "guild_id": { "type": "string" }, "inviter_id": { "type": ["string", "null"] }, "max_age": { "format": "int32", "type": ["integer", "null"] }, "max_uses": { "format": "int32", "type": ["integer", "null"] }, "uses": { "format": "int32", "type": "integer" } }, "required": ["code", "guild_id", "channel_id", "inviter_id", "max_uses", "uses", "max_age", "created_at"], "type": "object" };
function validate63(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate63.evaluated;
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
              validate63.errors = [{ instancePath: instancePath + "/" + i0, schemaPath: "#/$defs/GuildInvite/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
              return false;
            } else {
              if (data0.channel_id !== void 0) {
                const _errs4 = errors;
                if (typeof data0.channel_id !== "string") {
                  validate63.errors = [{ instancePath: instancePath + "/" + i0 + "/channel_id", schemaPath: "#/$defs/GuildInvite/properties/channel_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                    validate63.errors = [{ instancePath: instancePath + "/" + i0 + "/code", schemaPath: "#/$defs/GuildInvite/properties/code/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                      validate63.errors = [{ instancePath: instancePath + "/" + i0 + "/created_at", schemaPath: "#/$defs/GuildInvite/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                        validate63.errors = [{ instancePath: instancePath + "/" + i0 + "/guild_id", schemaPath: "#/$defs/GuildInvite/properties/guild_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                          validate63.errors = [{ instancePath: instancePath + "/" + i0 + "/inviter_id", schemaPath: "#/$defs/GuildInvite/properties/inviter_id/type", keyword: "type", params: { type: schema86.properties.inviter_id.type }, message: "must be string,null" }];
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
                            validate63.errors = [{ instancePath: instancePath + "/" + i0 + "/max_age", schemaPath: "#/$defs/GuildInvite/properties/max_age/type", keyword: "type", params: { type: schema86.properties.max_age.type }, message: "must be integer,null" }];
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
                              validate63.errors = [{ instancePath: instancePath + "/" + i0 + "/max_uses", schemaPath: "#/$defs/GuildInvite/properties/max_uses/type", keyword: "type", params: { type: schema86.properties.max_uses.type }, message: "must be integer,null" }];
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
                                validate63.errors = [{ instancePath: instancePath + "/" + i0 + "/uses", schemaPath: "#/$defs/GuildInvite/properties/uses/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
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
            validate63.errors = [{ instancePath: instancePath + "/" + i0, schemaPath: "#/$defs/GuildInvite/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
            return false;
          }
        }
        var valid0 = _errs1 === errors;
        if (!valid0) {
          break;
        }
      }
    } else {
      validate63.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
      return false;
    }
  }
  validate63.errors = vErrors;
  return errors === 0;
}
validate63.evaluated = { "items": true, "dynamicProps": false, "dynamicItems": false };
var isGuildSummary = validate64;
var schema87 = { "$defs": { "GuildBotConfig": { "additionalProperties": true, "properties": { "enabled": { "type": ["boolean", "null"] } }, "type": "object" }, "GuildVisibility": { "enum": ["private", "public", "roles"], "type": "string" }, "HubSettings": { "additionalProperties": true, "properties": { "description": { "type": ["string", "null"] }, "pinned_channels": { "items": { "type": "string" }, "type": ["array", "null"] }, "welcome_text": { "type": ["string", "null"] } }, "type": "object" } }, "$id": "urn:paracord:contract:GuildSummary", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "Space metadata used by the authenticated space list and navigation.\nNullable fields are present in responses, including when their value is null.", "properties": { "allowed_roles": { "items": { "type": "string" }, "type": "array" }, "banner_hash": { "default": null, "description": "`/api/v1/guilds/{id}/banner?v=\u2026` once a banner is uploaded, otherwise null.\nThe version changes with every upload. This server always sends it; it\nis optional in the contract because servers older than 3.2 (no banners)\nleave it out of the summary, and absent reads exactly as null.", "type": ["string", "null"] }, "bot_settings": { "additionalProperties": { "$ref": "#/$defs/GuildBotConfig" }, "type": ["object", "null"] }, "created_at": { "type": "string" }, "description": { "type": ["string", "null"] }, "discovery_tags": { "items": { "type": "string" }, "type": "array" }, "hub_settings": { "anyOf": [{ "$ref": "#/$defs/HubSettings" }, { "type": "null" }] }, "hue": { "default": null, "description": `The server's color as a hue, 0-359. Null when unset; clients then
derive one from the id. This server always sends it. It is optional in
the contract for protocol-version tolerance: a server from before
server colors leaves it out, which a client reads as null (no color
picked) and as "this server cannot store a color".`, "format": "uint32", "maximum": 359, "minimum": 0, "type": ["integer", "null"] }, "icon_hash": { "type": ["string", "null"] }, "id": { "type": "string" }, "member_count": { "format": "uint32", "maximum": 4294967295, "minimum": 0, "type": "integer" }, "name": { "type": "string" }, "owner_id": { "type": "string" }, "visibility": { "$ref": "#/$defs/GuildVisibility" } }, "required": ["id", "name", "description", "icon_hash", "owner_id", "member_count", "created_at", "visibility", "allowed_roles", "discovery_tags", "hub_settings", "bot_settings"], "title": "GuildSummary", "type": "object" };
var schema88 = { "additionalProperties": true, "properties": { "enabled": { "type": ["boolean", "null"] } }, "type": "object" };
var schema89 = { "additionalProperties": true, "properties": { "description": { "type": ["string", "null"] }, "pinned_channels": { "items": { "type": "string" }, "type": ["array", "null"] }, "welcome_text": { "type": ["string", "null"] } }, "type": "object" };
var schema90 = { "enum": ["private", "public", "roles"], "type": "string" };
function validate64(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate64.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.id === void 0 && (missing0 = "id") || data.name === void 0 && (missing0 = "name") || data.description === void 0 && (missing0 = "description") || data.icon_hash === void 0 && (missing0 = "icon_hash") || data.owner_id === void 0 && (missing0 = "owner_id") || data.member_count === void 0 && (missing0 = "member_count") || data.created_at === void 0 && (missing0 = "created_at") || data.visibility === void 0 && (missing0 = "visibility") || data.allowed_roles === void 0 && (missing0 = "allowed_roles") || data.discovery_tags === void 0 && (missing0 = "discovery_tags") || data.hub_settings === void 0 && (missing0 = "hub_settings") || data.bot_settings === void 0 && (missing0 = "bot_settings")) {
        validate64.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
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
                  validate64.errors = [{ instancePath: instancePath + "/allowed_roles/" + i0, schemaPath: "#/properties/allowed_roles/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid1 = _errs3 === errors;
                if (!valid1) {
                  break;
                }
              }
            } else {
              validate64.errors = [{ instancePath: instancePath + "/allowed_roles", schemaPath: "#/properties/allowed_roles/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
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
              validate64.errors = [{ instancePath: instancePath + "/banner_hash", schemaPath: "#/properties/banner_hash/type", keyword: "type", params: { type: schema87.properties.banner_hash.type }, message: "must be string,null" }];
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
                validate64.errors = [{ instancePath: instancePath + "/bot_settings", schemaPath: "#/properties/bot_settings/type", keyword: "type", params: { type: schema87.properties.bot_settings.type }, message: "must be object,null" }];
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
                            validate64.errors = [{ instancePath: instancePath + "/bot_settings/" + key0.replace(/~/g, "~0").replace(/\//g, "~1") + "/enabled", schemaPath: "#/$defs/GuildBotConfig/properties/enabled/type", keyword: "type", params: { type: schema88.properties.enabled.type }, message: "must be boolean,null" }];
                            return false;
                          }
                        }
                      } else {
                        validate64.errors = [{ instancePath: instancePath + "/bot_settings/" + key0.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/$defs/GuildBotConfig/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
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
                  validate64.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                    validate64.errors = [{ instancePath: instancePath + "/description", schemaPath: "#/properties/description/type", keyword: "type", params: { type: schema87.properties.description.type }, message: "must be string,null" }];
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
                            validate64.errors = [{ instancePath: instancePath + "/discovery_tags/" + i1, schemaPath: "#/properties/discovery_tags/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                            return false;
                          }
                          var valid5 = _errs22 === errors;
                          if (!valid5) {
                            break;
                          }
                        }
                      } else {
                        validate64.errors = [{ instancePath: instancePath + "/discovery_tags", schemaPath: "#/properties/discovery_tags/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
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
                              const err0 = { instancePath: instancePath + "/hub_settings/description", schemaPath: "#/$defs/HubSettings/properties/description/type", keyword: "type", params: { type: schema89.properties.description.type }, message: "must be string,null" };
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
                                const err1 = { instancePath: instancePath + "/hub_settings/pinned_channels", schemaPath: "#/$defs/HubSettings/properties/pinned_channels/type", keyword: "type", params: { type: schema89.properties.pinned_channels.type }, message: "must be array,null" };
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
                                  const err3 = { instancePath: instancePath + "/hub_settings/welcome_text", schemaPath: "#/$defs/HubSettings/properties/welcome_text/type", keyword: "type", params: { type: schema89.properties.welcome_text.type }, message: "must be string,null" };
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
                        validate64.errors = vErrors;
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
                      if (data.hue !== void 0) {
                        let data15 = data.hue;
                        const _errs40 = errors;
                        if (!(typeof data15 == "number" && (!(data15 % 1) && !isNaN(data15)) && isFinite(data15)) && data15 !== null) {
                          validate64.errors = [{ instancePath: instancePath + "/hue", schemaPath: "#/properties/hue/type", keyword: "type", params: { type: schema87.properties.hue.type }, message: "must be integer,null" }];
                          return false;
                        }
                        if (errors === _errs40) {
                          if (typeof data15 == "number" && isFinite(data15)) {
                            if (data15 > 359 || isNaN(data15)) {
                              validate64.errors = [{ instancePath: instancePath + "/hue", schemaPath: "#/properties/hue/maximum", keyword: "maximum", params: { comparison: "<=", limit: 359 }, message: "must be <= 359" }];
                              return false;
                            } else {
                              if (data15 < 0 || isNaN(data15)) {
                                validate64.errors = [{ instancePath: instancePath + "/hue", schemaPath: "#/properties/hue/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                return false;
                              }
                            }
                          }
                        }
                        var valid0 = _errs40 === errors;
                      } else {
                        var valid0 = true;
                      }
                      if (valid0) {
                        if (data.icon_hash !== void 0) {
                          let data16 = data.icon_hash;
                          const _errs42 = errors;
                          if (typeof data16 !== "string" && data16 !== null) {
                            validate64.errors = [{ instancePath: instancePath + "/icon_hash", schemaPath: "#/properties/icon_hash/type", keyword: "type", params: { type: schema87.properties.icon_hash.type }, message: "must be string,null" }];
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
                              validate64.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                validate64.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                                return false;
                              }
                              if (errors === _errs46) {
                                if (typeof data18 == "number" && isFinite(data18)) {
                                  if (data18 > 4294967295 || isNaN(data18)) {
                                    validate64.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" }];
                                    return false;
                                  } else {
                                    if (data18 < 0 || isNaN(data18)) {
                                      validate64.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
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
                                  validate64.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                    validate64.errors = [{ instancePath: instancePath + "/owner_id", schemaPath: "#/properties/owner_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                    return false;
                                  }
                                  var valid0 = _errs50 === errors;
                                } else {
                                  var valid0 = true;
                                }
                                if (valid0) {
                                  if (data.visibility !== void 0) {
                                    let data21 = data.visibility;
                                    const _errs52 = errors;
                                    if (typeof data21 !== "string") {
                                      validate64.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/$defs/GuildVisibility/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                      return false;
                                    }
                                    if (!(data21 === "private" || data21 === "public" || data21 === "roles")) {
                                      validate64.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/$defs/GuildVisibility/enum", keyword: "enum", params: { allowedValues: schema90.enum }, message: "must be equal to one of the allowed values" }];
                                      return false;
                                    }
                                    var valid0 = _errs52 === errors;
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
      validate64.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate64.errors = vErrors;
  return errors === 0;
}
validate64.evaluated = { "props": { "allowed_roles": true, "banner_hash": true, "bot_settings": true, "created_at": true, "description": true, "discovery_tags": true, "hub_settings": true, "hue": true, "icon_hash": true, "id": true, "member_count": true, "name": true, "owner_id": true, "visibility": true }, "dynamicProps": false, "dynamicItems": false };
var isGuildSummaryList = validate65;
var schema92 = { "description": "Space metadata used by the authenticated space list and navigation.\nNullable fields are present in responses, including when their value is null.", "properties": { "allowed_roles": { "items": { "type": "string" }, "type": "array" }, "banner_hash": { "default": null, "description": "`/api/v1/guilds/{id}/banner?v=\u2026` once a banner is uploaded, otherwise null.\nThe version changes with every upload. This server always sends it; it\nis optional in the contract because servers older than 3.2 (no banners)\nleave it out of the summary, and absent reads exactly as null.", "type": ["string", "null"] }, "bot_settings": { "additionalProperties": { "$ref": "#/$defs/GuildBotConfig" }, "type": ["object", "null"] }, "created_at": { "type": "string" }, "description": { "type": ["string", "null"] }, "discovery_tags": { "items": { "type": "string" }, "type": "array" }, "hub_settings": { "anyOf": [{ "$ref": "#/$defs/HubSettings" }, { "type": "null" }] }, "hue": { "default": null, "description": `The server's color as a hue, 0-359. Null when unset; clients then
derive one from the id. This server always sends it. It is optional in
the contract for protocol-version tolerance: a server from before
server colors leaves it out, which a client reads as null (no color
picked) and as "this server cannot store a color".`, "format": "uint32", "maximum": 359, "minimum": 0, "type": ["integer", "null"] }, "icon_hash": { "type": ["string", "null"] }, "id": { "type": "string" }, "member_count": { "format": "uint32", "maximum": 4294967295, "minimum": 0, "type": "integer" }, "name": { "type": "string" }, "owner_id": { "type": "string" }, "visibility": { "$ref": "#/$defs/GuildVisibility" } }, "required": ["id", "name", "description", "icon_hash", "owner_id", "member_count", "created_at", "visibility", "allowed_roles", "discovery_tags", "hub_settings", "bot_settings"], "type": "object" };
var schema93 = { "additionalProperties": true, "properties": { "enabled": { "type": ["boolean", "null"] } }, "type": "object" };
var schema94 = { "additionalProperties": true, "properties": { "description": { "type": ["string", "null"] }, "pinned_channels": { "items": { "type": "string" }, "type": ["array", "null"] }, "welcome_text": { "type": ["string", "null"] } }, "type": "object" };
var schema95 = { "enum": ["private", "public", "roles"], "type": "string" };
function validate66(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate66.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.id === void 0 && (missing0 = "id") || data.name === void 0 && (missing0 = "name") || data.description === void 0 && (missing0 = "description") || data.icon_hash === void 0 && (missing0 = "icon_hash") || data.owner_id === void 0 && (missing0 = "owner_id") || data.member_count === void 0 && (missing0 = "member_count") || data.created_at === void 0 && (missing0 = "created_at") || data.visibility === void 0 && (missing0 = "visibility") || data.allowed_roles === void 0 && (missing0 = "allowed_roles") || data.discovery_tags === void 0 && (missing0 = "discovery_tags") || data.hub_settings === void 0 && (missing0 = "hub_settings") || data.bot_settings === void 0 && (missing0 = "bot_settings")) {
        validate66.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
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
                  validate66.errors = [{ instancePath: instancePath + "/allowed_roles/" + i0, schemaPath: "#/properties/allowed_roles/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid1 = _errs3 === errors;
                if (!valid1) {
                  break;
                }
              }
            } else {
              validate66.errors = [{ instancePath: instancePath + "/allowed_roles", schemaPath: "#/properties/allowed_roles/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
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
              validate66.errors = [{ instancePath: instancePath + "/banner_hash", schemaPath: "#/properties/banner_hash/type", keyword: "type", params: { type: schema92.properties.banner_hash.type }, message: "must be string,null" }];
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
                validate66.errors = [{ instancePath: instancePath + "/bot_settings", schemaPath: "#/properties/bot_settings/type", keyword: "type", params: { type: schema92.properties.bot_settings.type }, message: "must be object,null" }];
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
                            validate66.errors = [{ instancePath: instancePath + "/bot_settings/" + key0.replace(/~/g, "~0").replace(/\//g, "~1") + "/enabled", schemaPath: "#/$defs/GuildBotConfig/properties/enabled/type", keyword: "type", params: { type: schema93.properties.enabled.type }, message: "must be boolean,null" }];
                            return false;
                          }
                        }
                      } else {
                        validate66.errors = [{ instancePath: instancePath + "/bot_settings/" + key0.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/$defs/GuildBotConfig/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
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
                  validate66.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                    validate66.errors = [{ instancePath: instancePath + "/description", schemaPath: "#/properties/description/type", keyword: "type", params: { type: schema92.properties.description.type }, message: "must be string,null" }];
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
                            validate66.errors = [{ instancePath: instancePath + "/discovery_tags/" + i1, schemaPath: "#/properties/discovery_tags/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                            return false;
                          }
                          var valid5 = _errs22 === errors;
                          if (!valid5) {
                            break;
                          }
                        }
                      } else {
                        validate66.errors = [{ instancePath: instancePath + "/discovery_tags", schemaPath: "#/properties/discovery_tags/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
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
                              const err0 = { instancePath: instancePath + "/hub_settings/description", schemaPath: "#/$defs/HubSettings/properties/description/type", keyword: "type", params: { type: schema94.properties.description.type }, message: "must be string,null" };
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
                                const err1 = { instancePath: instancePath + "/hub_settings/pinned_channels", schemaPath: "#/$defs/HubSettings/properties/pinned_channels/type", keyword: "type", params: { type: schema94.properties.pinned_channels.type }, message: "must be array,null" };
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
                                  const err3 = { instancePath: instancePath + "/hub_settings/welcome_text", schemaPath: "#/$defs/HubSettings/properties/welcome_text/type", keyword: "type", params: { type: schema94.properties.welcome_text.type }, message: "must be string,null" };
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
                        validate66.errors = vErrors;
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
                      if (data.hue !== void 0) {
                        let data15 = data.hue;
                        const _errs40 = errors;
                        if (!(typeof data15 == "number" && (!(data15 % 1) && !isNaN(data15)) && isFinite(data15)) && data15 !== null) {
                          validate66.errors = [{ instancePath: instancePath + "/hue", schemaPath: "#/properties/hue/type", keyword: "type", params: { type: schema92.properties.hue.type }, message: "must be integer,null" }];
                          return false;
                        }
                        if (errors === _errs40) {
                          if (typeof data15 == "number" && isFinite(data15)) {
                            if (data15 > 359 || isNaN(data15)) {
                              validate66.errors = [{ instancePath: instancePath + "/hue", schemaPath: "#/properties/hue/maximum", keyword: "maximum", params: { comparison: "<=", limit: 359 }, message: "must be <= 359" }];
                              return false;
                            } else {
                              if (data15 < 0 || isNaN(data15)) {
                                validate66.errors = [{ instancePath: instancePath + "/hue", schemaPath: "#/properties/hue/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                return false;
                              }
                            }
                          }
                        }
                        var valid0 = _errs40 === errors;
                      } else {
                        var valid0 = true;
                      }
                      if (valid0) {
                        if (data.icon_hash !== void 0) {
                          let data16 = data.icon_hash;
                          const _errs42 = errors;
                          if (typeof data16 !== "string" && data16 !== null) {
                            validate66.errors = [{ instancePath: instancePath + "/icon_hash", schemaPath: "#/properties/icon_hash/type", keyword: "type", params: { type: schema92.properties.icon_hash.type }, message: "must be string,null" }];
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
                              validate66.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                validate66.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                                return false;
                              }
                              if (errors === _errs46) {
                                if (typeof data18 == "number" && isFinite(data18)) {
                                  if (data18 > 4294967295 || isNaN(data18)) {
                                    validate66.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" }];
                                    return false;
                                  } else {
                                    if (data18 < 0 || isNaN(data18)) {
                                      validate66.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
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
                                  validate66.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                    validate66.errors = [{ instancePath: instancePath + "/owner_id", schemaPath: "#/properties/owner_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                    return false;
                                  }
                                  var valid0 = _errs50 === errors;
                                } else {
                                  var valid0 = true;
                                }
                                if (valid0) {
                                  if (data.visibility !== void 0) {
                                    let data21 = data.visibility;
                                    const _errs52 = errors;
                                    if (typeof data21 !== "string") {
                                      validate66.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/$defs/GuildVisibility/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                      return false;
                                    }
                                    if (!(data21 === "private" || data21 === "public" || data21 === "roles")) {
                                      validate66.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/$defs/GuildVisibility/enum", keyword: "enum", params: { allowedValues: schema95.enum }, message: "must be equal to one of the allowed values" }];
                                      return false;
                                    }
                                    var valid0 = _errs52 === errors;
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
      validate66.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate66.errors = vErrors;
  return errors === 0;
}
validate66.evaluated = { "props": { "allowed_roles": true, "banner_hash": true, "bot_settings": true, "created_at": true, "description": true, "discovery_tags": true, "hub_settings": true, "hue": true, "icon_hash": true, "id": true, "member_count": true, "name": true, "owner_id": true, "visibility": true }, "dynamicProps": false, "dynamicItems": false };
function validate65(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate65.evaluated;
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
        if (!validate66(data[i0], { instancePath: instancePath + "/" + i0, parentData: data, parentDataProperty: i0, rootData, dynamicAnchors })) {
          vErrors = vErrors === null ? validate66.errors : vErrors.concat(validate66.errors);
          errors = vErrors.length;
        }
        var valid0 = _errs1 === errors;
        if (!valid0) {
          break;
        }
      }
    } else {
      validate65.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
      return false;
    }
  }
  validate65.errors = vErrors;
  return errors === 0;
}
validate65.evaluated = { "items": true, "dynamicProps": false, "dynamicItems": false };
var isHostPreflight = validate68;
var schema96 = { "$defs": { "HostPreflightReason": { "description": "Why the desktop app cannot host on this computer (spec \xA72.3).", "oneOf": [{ "enum": ["no_user_services", "no_keychain", "existing_server", "no_port", "no_space"], "type": "string" }, { "const": "already_hosting", "description": "Never blocks: setup resumes at the first incomplete row.", "type": "string" }] } }, "$id": "urn:paracord:contract:HostPreflight", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "Tauri `host_preflight()`: `{ ok: true, port }` or\n`{ ok: false, reason, detail?, existing_url? }`; `already_hosting` comes\nwith `ok: true`.", "properties": { "detail": { "type": ["string", "null"] }, "existing_url": { "description": "With `existing_server`: the URL to sign in to instead.", "type": ["string", "null"] }, "ok": { "type": "boolean" }, "port": { "format": "uint16", "maximum": 65535, "minimum": 0, "type": ["integer", "null"] }, "reason": { "anyOf": [{ "$ref": "#/$defs/HostPreflightReason" }, { "type": "null" }] } }, "required": ["ok"], "title": "HostPreflight", "type": "object" };
var schema97 = { "description": "Why the desktop app cannot host on this computer (spec \xA72.3).", "oneOf": [{ "enum": ["no_user_services", "no_keychain", "existing_server", "no_port", "no_space"], "type": "string" }, { "const": "already_hosting", "description": "Never blocks: setup resumes at the first incomplete row.", "type": "string" }] };
function validate68(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate68.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.ok === void 0 && (missing0 = "ok")) {
        validate68.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.detail !== void 0) {
          let data0 = data.detail;
          const _errs1 = errors;
          if (typeof data0 !== "string" && data0 !== null) {
            validate68.errors = [{ instancePath: instancePath + "/detail", schemaPath: "#/properties/detail/type", keyword: "type", params: { type: schema96.properties.detail.type }, message: "must be string,null" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.existing_url !== void 0) {
            let data1 = data.existing_url;
            const _errs3 = errors;
            if (typeof data1 !== "string" && data1 !== null) {
              validate68.errors = [{ instancePath: instancePath + "/existing_url", schemaPath: "#/properties/existing_url/type", keyword: "type", params: { type: schema96.properties.existing_url.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.ok !== void 0) {
              const _errs5 = errors;
              if (typeof data.ok !== "boolean") {
                validate68.errors = [{ instancePath: instancePath + "/ok", schemaPath: "#/properties/ok/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.port !== void 0) {
                let data3 = data.port;
                const _errs7 = errors;
                if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3)) && data3 !== null) {
                  validate68.errors = [{ instancePath: instancePath + "/port", schemaPath: "#/properties/port/type", keyword: "type", params: { type: schema96.properties.port.type }, message: "must be integer,null" }];
                  return false;
                }
                if (errors === _errs7) {
                  if (typeof data3 == "number" && isFinite(data3)) {
                    if (data3 > 65535 || isNaN(data3)) {
                      validate68.errors = [{ instancePath: instancePath + "/port", schemaPath: "#/properties/port/maximum", keyword: "maximum", params: { comparison: "<=", limit: 65535 }, message: "must be <= 65535" }];
                      return false;
                    } else {
                      if (data3 < 0 || isNaN(data3)) {
                        validate68.errors = [{ instancePath: instancePath + "/port", schemaPath: "#/properties/port/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
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
                if (data.reason !== void 0) {
                  let data4 = data.reason;
                  const _errs9 = errors;
                  const _errs10 = errors;
                  let valid1 = false;
                  const _errs11 = errors;
                  const _errs13 = errors;
                  let valid3 = false;
                  let passing0 = null;
                  const _errs14 = errors;
                  if (typeof data4 !== "string") {
                    const err0 = { instancePath: instancePath + "/reason", schemaPath: "#/$defs/HostPreflightReason/oneOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err0];
                    } else {
                      vErrors.push(err0);
                    }
                    errors++;
                  }
                  if (!(data4 === "no_user_services" || data4 === "no_keychain" || data4 === "existing_server" || data4 === "no_port" || data4 === "no_space")) {
                    const err1 = { instancePath: instancePath + "/reason", schemaPath: "#/$defs/HostPreflightReason/oneOf/0/enum", keyword: "enum", params: { allowedValues: schema97.oneOf[0].enum }, message: "must be equal to one of the allowed values" };
                    if (vErrors === null) {
                      vErrors = [err1];
                    } else {
                      vErrors.push(err1);
                    }
                    errors++;
                  }
                  var _valid1 = _errs14 === errors;
                  if (_valid1) {
                    valid3 = true;
                    passing0 = 0;
                  }
                  const _errs16 = errors;
                  if (typeof data4 !== "string") {
                    const err2 = { instancePath: instancePath + "/reason", schemaPath: "#/$defs/HostPreflightReason/oneOf/1/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err2];
                    } else {
                      vErrors.push(err2);
                    }
                    errors++;
                  }
                  if ("already_hosting" !== data4) {
                    const err3 = { instancePath: instancePath + "/reason", schemaPath: "#/$defs/HostPreflightReason/oneOf/1/const", keyword: "const", params: { allowedValue: "already_hosting" }, message: "must be equal to constant" };
                    if (vErrors === null) {
                      vErrors = [err3];
                    } else {
                      vErrors.push(err3);
                    }
                    errors++;
                  }
                  var _valid1 = _errs16 === errors;
                  if (_valid1 && valid3) {
                    valid3 = false;
                    passing0 = [passing0, 1];
                  } else {
                    if (_valid1) {
                      valid3 = true;
                      passing0 = 1;
                    }
                  }
                  if (!valid3) {
                    const err4 = { instancePath: instancePath + "/reason", schemaPath: "#/$defs/HostPreflightReason/oneOf", keyword: "oneOf", params: { passingSchemas: passing0 }, message: "must match exactly one schema in oneOf" };
                    if (vErrors === null) {
                      vErrors = [err4];
                    } else {
                      vErrors.push(err4);
                    }
                    errors++;
                  } else {
                    errors = _errs13;
                    if (vErrors !== null) {
                      if (_errs13) {
                        vErrors.length = _errs13;
                      } else {
                        vErrors = null;
                      }
                    }
                  }
                  var _valid0 = _errs11 === errors;
                  valid1 = valid1 || _valid0;
                  const _errs18 = errors;
                  if (data4 !== null) {
                    const err5 = { instancePath: instancePath + "/reason", schemaPath: "#/properties/reason/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                    if (vErrors === null) {
                      vErrors = [err5];
                    } else {
                      vErrors.push(err5);
                    }
                    errors++;
                  }
                  var _valid0 = _errs18 === errors;
                  valid1 = valid1 || _valid0;
                  if (!valid1) {
                    const err6 = { instancePath: instancePath + "/reason", schemaPath: "#/properties/reason/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                    if (vErrors === null) {
                      vErrors = [err6];
                    } else {
                      vErrors.push(err6);
                    }
                    errors++;
                    validate68.errors = vErrors;
                    return false;
                  } else {
                    errors = _errs10;
                    if (vErrors !== null) {
                      if (_errs10) {
                        vErrors.length = _errs10;
                      } else {
                        vErrors = null;
                      }
                    }
                  }
                  var valid0 = _errs9 === errors;
                } else {
                  var valid0 = true;
                }
              }
            }
          }
        }
      }
    } else {
      validate68.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate68.errors = vErrors;
  return errors === 0;
}
validate68.evaluated = { "props": { "detail": true, "existing_url": true, "ok": true, "port": true, "reason": true }, "dynamicProps": false, "dynamicItems": false };
var isHostProgress = validate69;
var schema98 = { "$defs": { "HostProgressState": { "description": "The state a setup row is in.", "enum": ["run", "ok", "warn", "fail"], "type": "string" }, "HostSetupStep": { "description": "A step of `host_setup_start` (spec \xA72.6). Row 3 (the account) runs in JS.", "enum": ["install", "init", "service", "start", "storage", "reach", "backup"], "type": "string" } }, "$id": "urn:paracord:contract:HostProgress", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "Tauri event `host://progress`.", "properties": { "code": { "description": "A machine-readable reason, e.g. a reachability state or exit code.", "type": ["string", "null"] }, "detail": { "type": ["string", "null"] }, "row": { "description": "The setup row, 1-5.", "format": "uint8", "maximum": 255, "minimum": 0, "type": "integer" }, "state": { "$ref": "#/$defs/HostProgressState" }, "step": { "$ref": "#/$defs/HostSetupStep" } }, "required": ["row", "step", "state"], "title": "HostProgress", "type": "object" };
var schema99 = { "description": "The state a setup row is in.", "enum": ["run", "ok", "warn", "fail"], "type": "string" };
var schema100 = { "description": "A step of `host_setup_start` (spec \xA72.6). Row 3 (the account) runs in JS.", "enum": ["install", "init", "service", "start", "storage", "reach", "backup"], "type": "string" };
function validate69(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate69.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.row === void 0 && (missing0 = "row") || data.step === void 0 && (missing0 = "step") || data.state === void 0 && (missing0 = "state")) {
        validate69.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.code !== void 0) {
          let data0 = data.code;
          const _errs1 = errors;
          if (typeof data0 !== "string" && data0 !== null) {
            validate69.errors = [{ instancePath: instancePath + "/code", schemaPath: "#/properties/code/type", keyword: "type", params: { type: schema98.properties.code.type }, message: "must be string,null" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.detail !== void 0) {
            let data1 = data.detail;
            const _errs3 = errors;
            if (typeof data1 !== "string" && data1 !== null) {
              validate69.errors = [{ instancePath: instancePath + "/detail", schemaPath: "#/properties/detail/type", keyword: "type", params: { type: schema98.properties.detail.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.row !== void 0) {
              let data2 = data.row;
              const _errs5 = errors;
              if (!(typeof data2 == "number" && (!(data2 % 1) && !isNaN(data2)) && isFinite(data2))) {
                validate69.errors = [{ instancePath: instancePath + "/row", schemaPath: "#/properties/row/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                return false;
              }
              if (errors === _errs5) {
                if (typeof data2 == "number" && isFinite(data2)) {
                  if (data2 > 255 || isNaN(data2)) {
                    validate69.errors = [{ instancePath: instancePath + "/row", schemaPath: "#/properties/row/maximum", keyword: "maximum", params: { comparison: "<=", limit: 255 }, message: "must be <= 255" }];
                    return false;
                  } else {
                    if (data2 < 0 || isNaN(data2)) {
                      validate69.errors = [{ instancePath: instancePath + "/row", schemaPath: "#/properties/row/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                      return false;
                    }
                  }
                }
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.state !== void 0) {
                let data3 = data.state;
                const _errs7 = errors;
                if (typeof data3 !== "string") {
                  validate69.errors = [{ instancePath: instancePath + "/state", schemaPath: "#/$defs/HostProgressState/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                if (!(data3 === "run" || data3 === "ok" || data3 === "warn" || data3 === "fail")) {
                  validate69.errors = [{ instancePath: instancePath + "/state", schemaPath: "#/$defs/HostProgressState/enum", keyword: "enum", params: { allowedValues: schema99.enum }, message: "must be equal to one of the allowed values" }];
                  return false;
                }
                var valid0 = _errs7 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.step !== void 0) {
                  let data4 = data.step;
                  const _errs10 = errors;
                  if (typeof data4 !== "string") {
                    validate69.errors = [{ instancePath: instancePath + "/step", schemaPath: "#/$defs/HostSetupStep/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                  if (!(data4 === "install" || data4 === "init" || data4 === "service" || data4 === "start" || data4 === "storage" || data4 === "reach" || data4 === "backup")) {
                    validate69.errors = [{ instancePath: instancePath + "/step", schemaPath: "#/$defs/HostSetupStep/enum", keyword: "enum", params: { allowedValues: schema100.enum }, message: "must be equal to one of the allowed values" }];
                    return false;
                  }
                  var valid0 = _errs10 === errors;
                } else {
                  var valid0 = true;
                }
              }
            }
          }
        }
      }
    } else {
      validate69.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate69.errors = vErrors;
  return errors === 0;
}
validate69.evaluated = { "props": { "code": true, "detail": true, "row": true, "state": true, "step": true }, "dynamicProps": false, "dynamicItems": false };
var isHostStatus = validate70;
var schema101 = { "$defs": { "BackupStatus": { "description": "Automatic backups.", "properties": { "enabled": { "type": "boolean" }, "interval_seconds": { "format": "uint64", "minimum": 0, "type": "integer" }, "keep": { "description": "How many backups are kept.", "format": "uint32", "minimum": 0, "type": "integer" }, "last_backup_at": { "type": ["string", "null"] }, "last_error": { "type": ["string", "null"] } }, "required": ["enabled", "interval_seconds", "keep", "last_backup_at", "last_error"], "type": "object" }, "KeySource": { "description": "Where the at-rest storage key lives (`[at_rest] key_source`, spec \xA74.2).\nSpelled the same in the config file and on the wire.", "oneOf": [{ "const": "keychain", "description": "The OS credential store of the user the server runs as.", "type": "string" }, { "const": "systemd-creds", "description": "A `systemd-creds` credential loaded by the unit.", "type": "string" }, { "const": "file", "description": "A 0600 key file.", "type": "string" }, { "const": "env", "description": "An environment variable (`[at_rest] key_env`).", "type": "string" }] }, "Protection": { "description": "What protects the storage key, which decides the copy (spec \xA74.6).", "oneOf": [{ "const": "login", "description": "Unlocked by the user's sign-in (login keychain).", "type": "string" }, { "const": "tpm", "description": "Sealed to the machine's TPM.", "type": "string" }, { "const": "machine", "description": "Protected by the machine's own credentials.", "type": "string" }, { "const": "same_disk", "description": "Stored on the same disk as the data.", "type": "string" }] }, "Reachability": { "description": "The current reachability, as the server holds it.", "properties": { "confirmed_at": { "description": "When a connection from outside this network was observed.", "type": ["string", "null"] }, "external_ip": { "description": "Only ever what the router reported.", "type": ["string", "null"] }, "gateway_ip": { "type": ["string", "null"] }, "lan_ip": { "type": ["string", "null"] }, "last_error": { "type": ["string", "null"] }, "lease_expires_at": { "type": ["string", "null"] }, "method": { "description": '`"upnp"`, `"nat-pmp"` or `"pcp"`.', "type": ["string", "null"] }, "next_retry_at": { "type": ["string", "null"] }, "port": { "format": "uint16", "maximum": 65535, "minimum": 0, "type": "integer" }, "state": { "$ref": "#/$defs/ReachabilityState" } }, "required": ["state", "method", "external_ip", "gateway_ip", "lan_ip", "port", "lease_expires_at", "next_retry_at", "last_error", "confirmed_at"], "type": "object" }, "ReachabilityState": { "description": "What the router said, or what this computer knows, about whether people\noutside the home network can reach this server (spec \xA75.2).", "oneOf": [{ "const": "off", "description": "Automatic forwarding is off, or the server binds loopback.", "type": "string" }, { "const": "asking", "description": "An attempt is in flight.", "type": "string" }, { "const": "open", "description": "The router accepted both mappings and reported a public IPv4.", "type": "string" }, { "const": "shared_address", "description": "The router's own external address is private (carrier-grade NAT or\nanother router in front).", "type": "string" }, { "const": "refused", "description": "A gateway answered and refused.", "type": "string" }, { "const": "no_answer", "description": "No UPnP IGD, NAT-PMP or PCP gateway answered in time.", "type": "string" }, { "const": "direct", "description": "The bind interface has a public IPv4 itself.", "type": "string" }, { "const": "firewall_blocked", "description": "Windows only: the firewall rule is missing.", "type": "string" }] }, "StorageStatus": { "description": "Stored-data encryption as the running server observes it (spec \xA74.5).", "properties": { "enabled": { "type": "boolean" }, "escrowed": { "description": "The storage key is escrowed under the owner's recovery phrase (\xA74.7).", "type": "boolean" }, "files_encrypted": { "type": "boolean" }, "key_source": { "anyOf": [{ "$ref": "#/$defs/KeySource" }, { "type": "null" }] }, "protection": { "anyOf": [{ "$ref": "#/$defs/Protection" }, { "type": "null" }] }, "sqlite_encrypted": { "description": "From `PRAGMA cipher_version` on the live pool, not from config.", "type": "boolean" } }, "required": ["enabled", "sqlite_encrypted", "files_encrypted", "key_source", "protection", "escrowed"], "type": "object" }, "TlsStatus": { "description": "This server's TLS identity. Trust words are computed from the fingerprint by\nthe client (spec \xA77.1).", "properties": { "fingerprint_sha256": { "description": "hex SHA-256 of the leaf certificate's DER.", "type": "string" }, "self_signed": { "type": "boolean" } }, "required": ["fingerprint_sha256", "self_signed"], "type": "object" } }, "$id": "urn:paracord:contract:HostStatus", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "`GET /api/v1/host/status` (loopback + host token) and\n`GET /api/v1/admin/host-status` (admins).", "properties": { "backups": { "$ref": "#/$defs/BackupStatus" }, "instance_id": { "description": "`[host] instance_id`: the HKDF info of the owner's escrow key (spec\n\xA74.7), so a headless owner's first-run page can escrow the storage key\nafter the claim (\xA72.11). Absent on a server that has none (and on\nservers older than this field).", "type": ["string", "null"] }, "reachability": { "$ref": "#/$defs/Reachability" }, "setup_required": { "description": "True until the first owner claims the instance.", "type": "boolean" }, "started_at": { "type": "string" }, "storage": { "$ref": "#/$defs/StorageStatus" }, "tls": { "$ref": "#/$defs/TlsStatus" }, "version": { "type": "string" } }, "required": ["version", "started_at", "setup_required", "storage", "reachability", "backups", "tls"], "title": "HostStatus", "type": "object" };
var schema102 = { "description": "Automatic backups.", "properties": { "enabled": { "type": "boolean" }, "interval_seconds": { "format": "uint64", "minimum": 0, "type": "integer" }, "keep": { "description": "How many backups are kept.", "format": "uint32", "minimum": 0, "type": "integer" }, "last_backup_at": { "type": ["string", "null"] }, "last_error": { "type": ["string", "null"] } }, "required": ["enabled", "interval_seconds", "keep", "last_backup_at", "last_error"], "type": "object" };
var schema103 = { "description": "The current reachability, as the server holds it.", "properties": { "confirmed_at": { "description": "When a connection from outside this network was observed.", "type": ["string", "null"] }, "external_ip": { "description": "Only ever what the router reported.", "type": ["string", "null"] }, "gateway_ip": { "type": ["string", "null"] }, "lan_ip": { "type": ["string", "null"] }, "last_error": { "type": ["string", "null"] }, "lease_expires_at": { "type": ["string", "null"] }, "method": { "description": '`"upnp"`, `"nat-pmp"` or `"pcp"`.', "type": ["string", "null"] }, "next_retry_at": { "type": ["string", "null"] }, "port": { "format": "uint16", "maximum": 65535, "minimum": 0, "type": "integer" }, "state": { "$ref": "#/$defs/ReachabilityState" } }, "required": ["state", "method", "external_ip", "gateway_ip", "lan_ip", "port", "lease_expires_at", "next_retry_at", "last_error", "confirmed_at"], "type": "object" };
function validate71(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate71.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.state === void 0 && (missing0 = "state") || data.method === void 0 && (missing0 = "method") || data.external_ip === void 0 && (missing0 = "external_ip") || data.gateway_ip === void 0 && (missing0 = "gateway_ip") || data.lan_ip === void 0 && (missing0 = "lan_ip") || data.port === void 0 && (missing0 = "port") || data.lease_expires_at === void 0 && (missing0 = "lease_expires_at") || data.next_retry_at === void 0 && (missing0 = "next_retry_at") || data.last_error === void 0 && (missing0 = "last_error") || data.confirmed_at === void 0 && (missing0 = "confirmed_at")) {
        validate71.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.confirmed_at !== void 0) {
          let data0 = data.confirmed_at;
          const _errs1 = errors;
          if (typeof data0 !== "string" && data0 !== null) {
            validate71.errors = [{ instancePath: instancePath + "/confirmed_at", schemaPath: "#/properties/confirmed_at/type", keyword: "type", params: { type: schema103.properties.confirmed_at.type }, message: "must be string,null" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.external_ip !== void 0) {
            let data1 = data.external_ip;
            const _errs3 = errors;
            if (typeof data1 !== "string" && data1 !== null) {
              validate71.errors = [{ instancePath: instancePath + "/external_ip", schemaPath: "#/properties/external_ip/type", keyword: "type", params: { type: schema103.properties.external_ip.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.gateway_ip !== void 0) {
              let data2 = data.gateway_ip;
              const _errs5 = errors;
              if (typeof data2 !== "string" && data2 !== null) {
                validate71.errors = [{ instancePath: instancePath + "/gateway_ip", schemaPath: "#/properties/gateway_ip/type", keyword: "type", params: { type: schema103.properties.gateway_ip.type }, message: "must be string,null" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.lan_ip !== void 0) {
                let data3 = data.lan_ip;
                const _errs7 = errors;
                if (typeof data3 !== "string" && data3 !== null) {
                  validate71.errors = [{ instancePath: instancePath + "/lan_ip", schemaPath: "#/properties/lan_ip/type", keyword: "type", params: { type: schema103.properties.lan_ip.type }, message: "must be string,null" }];
                  return false;
                }
                var valid0 = _errs7 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.last_error !== void 0) {
                  let data4 = data.last_error;
                  const _errs9 = errors;
                  if (typeof data4 !== "string" && data4 !== null) {
                    validate71.errors = [{ instancePath: instancePath + "/last_error", schemaPath: "#/properties/last_error/type", keyword: "type", params: { type: schema103.properties.last_error.type }, message: "must be string,null" }];
                    return false;
                  }
                  var valid0 = _errs9 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.lease_expires_at !== void 0) {
                    let data5 = data.lease_expires_at;
                    const _errs11 = errors;
                    if (typeof data5 !== "string" && data5 !== null) {
                      validate71.errors = [{ instancePath: instancePath + "/lease_expires_at", schemaPath: "#/properties/lease_expires_at/type", keyword: "type", params: { type: schema103.properties.lease_expires_at.type }, message: "must be string,null" }];
                      return false;
                    }
                    var valid0 = _errs11 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.method !== void 0) {
                      let data6 = data.method;
                      const _errs13 = errors;
                      if (typeof data6 !== "string" && data6 !== null) {
                        validate71.errors = [{ instancePath: instancePath + "/method", schemaPath: "#/properties/method/type", keyword: "type", params: { type: schema103.properties.method.type }, message: "must be string,null" }];
                        return false;
                      }
                      var valid0 = _errs13 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.next_retry_at !== void 0) {
                        let data7 = data.next_retry_at;
                        const _errs15 = errors;
                        if (typeof data7 !== "string" && data7 !== null) {
                          validate71.errors = [{ instancePath: instancePath + "/next_retry_at", schemaPath: "#/properties/next_retry_at/type", keyword: "type", params: { type: schema103.properties.next_retry_at.type }, message: "must be string,null" }];
                          return false;
                        }
                        var valid0 = _errs15 === errors;
                      } else {
                        var valid0 = true;
                      }
                      if (valid0) {
                        if (data.port !== void 0) {
                          let data8 = data.port;
                          const _errs17 = errors;
                          if (!(typeof data8 == "number" && (!(data8 % 1) && !isNaN(data8)) && isFinite(data8))) {
                            validate71.errors = [{ instancePath: instancePath + "/port", schemaPath: "#/properties/port/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                            return false;
                          }
                          if (errors === _errs17) {
                            if (typeof data8 == "number" && isFinite(data8)) {
                              if (data8 > 65535 || isNaN(data8)) {
                                validate71.errors = [{ instancePath: instancePath + "/port", schemaPath: "#/properties/port/maximum", keyword: "maximum", params: { comparison: "<=", limit: 65535 }, message: "must be <= 65535" }];
                                return false;
                              } else {
                                if (data8 < 0 || isNaN(data8)) {
                                  validate71.errors = [{ instancePath: instancePath + "/port", schemaPath: "#/properties/port/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                  return false;
                                }
                              }
                            }
                          }
                          var valid0 = _errs17 === errors;
                        } else {
                          var valid0 = true;
                        }
                        if (valid0) {
                          if (data.state !== void 0) {
                            let data9 = data.state;
                            const _errs19 = errors;
                            const _errs21 = errors;
                            let valid2 = false;
                            let passing0 = null;
                            const _errs22 = errors;
                            if (typeof data9 !== "string") {
                              const err0 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                              if (vErrors === null) {
                                vErrors = [err0];
                              } else {
                                vErrors.push(err0);
                              }
                              errors++;
                            }
                            if ("off" !== data9) {
                              const err1 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/0/const", keyword: "const", params: { allowedValue: "off" }, message: "must be equal to constant" };
                              if (vErrors === null) {
                                vErrors = [err1];
                              } else {
                                vErrors.push(err1);
                              }
                              errors++;
                            }
                            var _valid0 = _errs22 === errors;
                            if (_valid0) {
                              valid2 = true;
                              passing0 = 0;
                            }
                            const _errs24 = errors;
                            if (typeof data9 !== "string") {
                              const err2 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/1/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                              if (vErrors === null) {
                                vErrors = [err2];
                              } else {
                                vErrors.push(err2);
                              }
                              errors++;
                            }
                            if ("asking" !== data9) {
                              const err3 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/1/const", keyword: "const", params: { allowedValue: "asking" }, message: "must be equal to constant" };
                              if (vErrors === null) {
                                vErrors = [err3];
                              } else {
                                vErrors.push(err3);
                              }
                              errors++;
                            }
                            var _valid0 = _errs24 === errors;
                            if (_valid0 && valid2) {
                              valid2 = false;
                              passing0 = [passing0, 1];
                            } else {
                              if (_valid0) {
                                valid2 = true;
                                passing0 = 1;
                              }
                              const _errs26 = errors;
                              if (typeof data9 !== "string") {
                                const err4 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/2/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                if (vErrors === null) {
                                  vErrors = [err4];
                                } else {
                                  vErrors.push(err4);
                                }
                                errors++;
                              }
                              if ("open" !== data9) {
                                const err5 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/2/const", keyword: "const", params: { allowedValue: "open" }, message: "must be equal to constant" };
                                if (vErrors === null) {
                                  vErrors = [err5];
                                } else {
                                  vErrors.push(err5);
                                }
                                errors++;
                              }
                              var _valid0 = _errs26 === errors;
                              if (_valid0 && valid2) {
                                valid2 = false;
                                passing0 = [passing0, 2];
                              } else {
                                if (_valid0) {
                                  valid2 = true;
                                  passing0 = 2;
                                }
                                const _errs28 = errors;
                                if (typeof data9 !== "string") {
                                  const err6 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/3/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                  if (vErrors === null) {
                                    vErrors = [err6];
                                  } else {
                                    vErrors.push(err6);
                                  }
                                  errors++;
                                }
                                if ("shared_address" !== data9) {
                                  const err7 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/3/const", keyword: "const", params: { allowedValue: "shared_address" }, message: "must be equal to constant" };
                                  if (vErrors === null) {
                                    vErrors = [err7];
                                  } else {
                                    vErrors.push(err7);
                                  }
                                  errors++;
                                }
                                var _valid0 = _errs28 === errors;
                                if (_valid0 && valid2) {
                                  valid2 = false;
                                  passing0 = [passing0, 3];
                                } else {
                                  if (_valid0) {
                                    valid2 = true;
                                    passing0 = 3;
                                  }
                                  const _errs30 = errors;
                                  if (typeof data9 !== "string") {
                                    const err8 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/4/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                    if (vErrors === null) {
                                      vErrors = [err8];
                                    } else {
                                      vErrors.push(err8);
                                    }
                                    errors++;
                                  }
                                  if ("refused" !== data9) {
                                    const err9 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/4/const", keyword: "const", params: { allowedValue: "refused" }, message: "must be equal to constant" };
                                    if (vErrors === null) {
                                      vErrors = [err9];
                                    } else {
                                      vErrors.push(err9);
                                    }
                                    errors++;
                                  }
                                  var _valid0 = _errs30 === errors;
                                  if (_valid0 && valid2) {
                                    valid2 = false;
                                    passing0 = [passing0, 4];
                                  } else {
                                    if (_valid0) {
                                      valid2 = true;
                                      passing0 = 4;
                                    }
                                    const _errs32 = errors;
                                    if (typeof data9 !== "string") {
                                      const err10 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/5/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                      if (vErrors === null) {
                                        vErrors = [err10];
                                      } else {
                                        vErrors.push(err10);
                                      }
                                      errors++;
                                    }
                                    if ("no_answer" !== data9) {
                                      const err11 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/5/const", keyword: "const", params: { allowedValue: "no_answer" }, message: "must be equal to constant" };
                                      if (vErrors === null) {
                                        vErrors = [err11];
                                      } else {
                                        vErrors.push(err11);
                                      }
                                      errors++;
                                    }
                                    var _valid0 = _errs32 === errors;
                                    if (_valid0 && valid2) {
                                      valid2 = false;
                                      passing0 = [passing0, 5];
                                    } else {
                                      if (_valid0) {
                                        valid2 = true;
                                        passing0 = 5;
                                      }
                                      const _errs34 = errors;
                                      if (typeof data9 !== "string") {
                                        const err12 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/6/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                        if (vErrors === null) {
                                          vErrors = [err12];
                                        } else {
                                          vErrors.push(err12);
                                        }
                                        errors++;
                                      }
                                      if ("direct" !== data9) {
                                        const err13 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/6/const", keyword: "const", params: { allowedValue: "direct" }, message: "must be equal to constant" };
                                        if (vErrors === null) {
                                          vErrors = [err13];
                                        } else {
                                          vErrors.push(err13);
                                        }
                                        errors++;
                                      }
                                      var _valid0 = _errs34 === errors;
                                      if (_valid0 && valid2) {
                                        valid2 = false;
                                        passing0 = [passing0, 6];
                                      } else {
                                        if (_valid0) {
                                          valid2 = true;
                                          passing0 = 6;
                                        }
                                        const _errs36 = errors;
                                        if (typeof data9 !== "string") {
                                          const err14 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/7/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                          if (vErrors === null) {
                                            vErrors = [err14];
                                          } else {
                                            vErrors.push(err14);
                                          }
                                          errors++;
                                        }
                                        if ("firewall_blocked" !== data9) {
                                          const err15 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/7/const", keyword: "const", params: { allowedValue: "firewall_blocked" }, message: "must be equal to constant" };
                                          if (vErrors === null) {
                                            vErrors = [err15];
                                          } else {
                                            vErrors.push(err15);
                                          }
                                          errors++;
                                        }
                                        var _valid0 = _errs36 === errors;
                                        if (_valid0 && valid2) {
                                          valid2 = false;
                                          passing0 = [passing0, 7];
                                        } else {
                                          if (_valid0) {
                                            valid2 = true;
                                            passing0 = 7;
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                            if (!valid2) {
                              const err16 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf", keyword: "oneOf", params: { passingSchemas: passing0 }, message: "must match exactly one schema in oneOf" };
                              if (vErrors === null) {
                                vErrors = [err16];
                              } else {
                                vErrors.push(err16);
                              }
                              errors++;
                              validate71.errors = vErrors;
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
                            var valid0 = _errs19 === errors;
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
      validate71.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate71.errors = vErrors;
  return errors === 0;
}
validate71.evaluated = { "props": { "confirmed_at": true, "external_ip": true, "gateway_ip": true, "lan_ip": true, "last_error": true, "lease_expires_at": true, "method": true, "next_retry_at": true, "port": true, "state": true }, "dynamicProps": false, "dynamicItems": false };
function validate73(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate73.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.enabled === void 0 && (missing0 = "enabled") || data.sqlite_encrypted === void 0 && (missing0 = "sqlite_encrypted") || data.files_encrypted === void 0 && (missing0 = "files_encrypted") || data.key_source === void 0 && (missing0 = "key_source") || data.protection === void 0 && (missing0 = "protection") || data.escrowed === void 0 && (missing0 = "escrowed")) {
        validate73.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.enabled !== void 0) {
          const _errs1 = errors;
          if (typeof data.enabled !== "boolean") {
            validate73.errors = [{ instancePath: instancePath + "/enabled", schemaPath: "#/properties/enabled/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.escrowed !== void 0) {
            const _errs3 = errors;
            if (typeof data.escrowed !== "boolean") {
              validate73.errors = [{ instancePath: instancePath + "/escrowed", schemaPath: "#/properties/escrowed/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.files_encrypted !== void 0) {
              const _errs5 = errors;
              if (typeof data.files_encrypted !== "boolean") {
                validate73.errors = [{ instancePath: instancePath + "/files_encrypted", schemaPath: "#/properties/files_encrypted/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.key_source !== void 0) {
                let data3 = data.key_source;
                const _errs7 = errors;
                const _errs8 = errors;
                let valid1 = false;
                const _errs9 = errors;
                const _errs11 = errors;
                let valid3 = false;
                let passing0 = null;
                const _errs12 = errors;
                if (typeof data3 !== "string") {
                  const err0 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                  if (vErrors === null) {
                    vErrors = [err0];
                  } else {
                    vErrors.push(err0);
                  }
                  errors++;
                }
                if ("keychain" !== data3) {
                  const err1 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf/0/const", keyword: "const", params: { allowedValue: "keychain" }, message: "must be equal to constant" };
                  if (vErrors === null) {
                    vErrors = [err1];
                  } else {
                    vErrors.push(err1);
                  }
                  errors++;
                }
                var _valid1 = _errs12 === errors;
                if (_valid1) {
                  valid3 = true;
                  passing0 = 0;
                }
                const _errs14 = errors;
                if (typeof data3 !== "string") {
                  const err2 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf/1/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                  if (vErrors === null) {
                    vErrors = [err2];
                  } else {
                    vErrors.push(err2);
                  }
                  errors++;
                }
                if ("systemd-creds" !== data3) {
                  const err3 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf/1/const", keyword: "const", params: { allowedValue: "systemd-creds" }, message: "must be equal to constant" };
                  if (vErrors === null) {
                    vErrors = [err3];
                  } else {
                    vErrors.push(err3);
                  }
                  errors++;
                }
                var _valid1 = _errs14 === errors;
                if (_valid1 && valid3) {
                  valid3 = false;
                  passing0 = [passing0, 1];
                } else {
                  if (_valid1) {
                    valid3 = true;
                    passing0 = 1;
                  }
                  const _errs16 = errors;
                  if (typeof data3 !== "string") {
                    const err4 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf/2/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err4];
                    } else {
                      vErrors.push(err4);
                    }
                    errors++;
                  }
                  if ("file" !== data3) {
                    const err5 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf/2/const", keyword: "const", params: { allowedValue: "file" }, message: "must be equal to constant" };
                    if (vErrors === null) {
                      vErrors = [err5];
                    } else {
                      vErrors.push(err5);
                    }
                    errors++;
                  }
                  var _valid1 = _errs16 === errors;
                  if (_valid1 && valid3) {
                    valid3 = false;
                    passing0 = [passing0, 2];
                  } else {
                    if (_valid1) {
                      valid3 = true;
                      passing0 = 2;
                    }
                    const _errs18 = errors;
                    if (typeof data3 !== "string") {
                      const err6 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf/3/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                      if (vErrors === null) {
                        vErrors = [err6];
                      } else {
                        vErrors.push(err6);
                      }
                      errors++;
                    }
                    if ("env" !== data3) {
                      const err7 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf/3/const", keyword: "const", params: { allowedValue: "env" }, message: "must be equal to constant" };
                      if (vErrors === null) {
                        vErrors = [err7];
                      } else {
                        vErrors.push(err7);
                      }
                      errors++;
                    }
                    var _valid1 = _errs18 === errors;
                    if (_valid1 && valid3) {
                      valid3 = false;
                      passing0 = [passing0, 3];
                    } else {
                      if (_valid1) {
                        valid3 = true;
                        passing0 = 3;
                      }
                    }
                  }
                }
                if (!valid3) {
                  const err8 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf", keyword: "oneOf", params: { passingSchemas: passing0 }, message: "must match exactly one schema in oneOf" };
                  if (vErrors === null) {
                    vErrors = [err8];
                  } else {
                    vErrors.push(err8);
                  }
                  errors++;
                } else {
                  errors = _errs11;
                  if (vErrors !== null) {
                    if (_errs11) {
                      vErrors.length = _errs11;
                    } else {
                      vErrors = null;
                    }
                  }
                }
                var _valid0 = _errs9 === errors;
                valid1 = valid1 || _valid0;
                const _errs20 = errors;
                if (data3 !== null) {
                  const err9 = { instancePath: instancePath + "/key_source", schemaPath: "#/properties/key_source/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                  if (vErrors === null) {
                    vErrors = [err9];
                  } else {
                    vErrors.push(err9);
                  }
                  errors++;
                }
                var _valid0 = _errs20 === errors;
                valid1 = valid1 || _valid0;
                if (!valid1) {
                  const err10 = { instancePath: instancePath + "/key_source", schemaPath: "#/properties/key_source/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                  if (vErrors === null) {
                    vErrors = [err10];
                  } else {
                    vErrors.push(err10);
                  }
                  errors++;
                  validate73.errors = vErrors;
                  return false;
                } else {
                  errors = _errs8;
                  if (vErrors !== null) {
                    if (_errs8) {
                      vErrors.length = _errs8;
                    } else {
                      vErrors = null;
                    }
                  }
                }
                var valid0 = _errs7 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.protection !== void 0) {
                  let data4 = data.protection;
                  const _errs22 = errors;
                  const _errs23 = errors;
                  let valid4 = false;
                  const _errs24 = errors;
                  const _errs26 = errors;
                  let valid6 = false;
                  let passing1 = null;
                  const _errs27 = errors;
                  if (typeof data4 !== "string") {
                    const err11 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err11];
                    } else {
                      vErrors.push(err11);
                    }
                    errors++;
                  }
                  if ("login" !== data4) {
                    const err12 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf/0/const", keyword: "const", params: { allowedValue: "login" }, message: "must be equal to constant" };
                    if (vErrors === null) {
                      vErrors = [err12];
                    } else {
                      vErrors.push(err12);
                    }
                    errors++;
                  }
                  var _valid3 = _errs27 === errors;
                  if (_valid3) {
                    valid6 = true;
                    passing1 = 0;
                  }
                  const _errs29 = errors;
                  if (typeof data4 !== "string") {
                    const err13 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf/1/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err13];
                    } else {
                      vErrors.push(err13);
                    }
                    errors++;
                  }
                  if ("tpm" !== data4) {
                    const err14 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf/1/const", keyword: "const", params: { allowedValue: "tpm" }, message: "must be equal to constant" };
                    if (vErrors === null) {
                      vErrors = [err14];
                    } else {
                      vErrors.push(err14);
                    }
                    errors++;
                  }
                  var _valid3 = _errs29 === errors;
                  if (_valid3 && valid6) {
                    valid6 = false;
                    passing1 = [passing1, 1];
                  } else {
                    if (_valid3) {
                      valid6 = true;
                      passing1 = 1;
                    }
                    const _errs31 = errors;
                    if (typeof data4 !== "string") {
                      const err15 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf/2/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                      if (vErrors === null) {
                        vErrors = [err15];
                      } else {
                        vErrors.push(err15);
                      }
                      errors++;
                    }
                    if ("machine" !== data4) {
                      const err16 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf/2/const", keyword: "const", params: { allowedValue: "machine" }, message: "must be equal to constant" };
                      if (vErrors === null) {
                        vErrors = [err16];
                      } else {
                        vErrors.push(err16);
                      }
                      errors++;
                    }
                    var _valid3 = _errs31 === errors;
                    if (_valid3 && valid6) {
                      valid6 = false;
                      passing1 = [passing1, 2];
                    } else {
                      if (_valid3) {
                        valid6 = true;
                        passing1 = 2;
                      }
                      const _errs33 = errors;
                      if (typeof data4 !== "string") {
                        const err17 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf/3/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                        if (vErrors === null) {
                          vErrors = [err17];
                        } else {
                          vErrors.push(err17);
                        }
                        errors++;
                      }
                      if ("same_disk" !== data4) {
                        const err18 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf/3/const", keyword: "const", params: { allowedValue: "same_disk" }, message: "must be equal to constant" };
                        if (vErrors === null) {
                          vErrors = [err18];
                        } else {
                          vErrors.push(err18);
                        }
                        errors++;
                      }
                      var _valid3 = _errs33 === errors;
                      if (_valid3 && valid6) {
                        valid6 = false;
                        passing1 = [passing1, 3];
                      } else {
                        if (_valid3) {
                          valid6 = true;
                          passing1 = 3;
                        }
                      }
                    }
                  }
                  if (!valid6) {
                    const err19 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf", keyword: "oneOf", params: { passingSchemas: passing1 }, message: "must match exactly one schema in oneOf" };
                    if (vErrors === null) {
                      vErrors = [err19];
                    } else {
                      vErrors.push(err19);
                    }
                    errors++;
                  } else {
                    errors = _errs26;
                    if (vErrors !== null) {
                      if (_errs26) {
                        vErrors.length = _errs26;
                      } else {
                        vErrors = null;
                      }
                    }
                  }
                  var _valid2 = _errs24 === errors;
                  valid4 = valid4 || _valid2;
                  const _errs35 = errors;
                  if (data4 !== null) {
                    const err20 = { instancePath: instancePath + "/protection", schemaPath: "#/properties/protection/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                    if (vErrors === null) {
                      vErrors = [err20];
                    } else {
                      vErrors.push(err20);
                    }
                    errors++;
                  }
                  var _valid2 = _errs35 === errors;
                  valid4 = valid4 || _valid2;
                  if (!valid4) {
                    const err21 = { instancePath: instancePath + "/protection", schemaPath: "#/properties/protection/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                    if (vErrors === null) {
                      vErrors = [err21];
                    } else {
                      vErrors.push(err21);
                    }
                    errors++;
                    validate73.errors = vErrors;
                    return false;
                  } else {
                    errors = _errs23;
                    if (vErrors !== null) {
                      if (_errs23) {
                        vErrors.length = _errs23;
                      } else {
                        vErrors = null;
                      }
                    }
                  }
                  var valid0 = _errs22 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.sqlite_encrypted !== void 0) {
                    const _errs37 = errors;
                    if (typeof data.sqlite_encrypted !== "boolean") {
                      validate73.errors = [{ instancePath: instancePath + "/sqlite_encrypted", schemaPath: "#/properties/sqlite_encrypted/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                      return false;
                    }
                    var valid0 = _errs37 === errors;
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
      validate73.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate73.errors = vErrors;
  return errors === 0;
}
validate73.evaluated = { "props": { "enabled": true, "escrowed": true, "files_encrypted": true, "key_source": true, "protection": true, "sqlite_encrypted": true }, "dynamicProps": false, "dynamicItems": false };
function validate70(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate70.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.version === void 0 && (missing0 = "version") || data.started_at === void 0 && (missing0 = "started_at") || data.setup_required === void 0 && (missing0 = "setup_required") || data.storage === void 0 && (missing0 = "storage") || data.reachability === void 0 && (missing0 = "reachability") || data.backups === void 0 && (missing0 = "backups") || data.tls === void 0 && (missing0 = "tls")) {
        validate70.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.backups !== void 0) {
          let data0 = data.backups;
          const _errs1 = errors;
          const _errs2 = errors;
          if (errors === _errs2) {
            if (data0 && typeof data0 == "object" && !Array.isArray(data0)) {
              let missing1;
              if (data0.enabled === void 0 && (missing1 = "enabled") || data0.interval_seconds === void 0 && (missing1 = "interval_seconds") || data0.keep === void 0 && (missing1 = "keep") || data0.last_backup_at === void 0 && (missing1 = "last_backup_at") || data0.last_error === void 0 && (missing1 = "last_error")) {
                validate70.errors = [{ instancePath: instancePath + "/backups", schemaPath: "#/$defs/BackupStatus/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                return false;
              } else {
                if (data0.enabled !== void 0) {
                  const _errs4 = errors;
                  if (typeof data0.enabled !== "boolean") {
                    validate70.errors = [{ instancePath: instancePath + "/backups/enabled", schemaPath: "#/$defs/BackupStatus/properties/enabled/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                    return false;
                  }
                  var valid2 = _errs4 === errors;
                } else {
                  var valid2 = true;
                }
                if (valid2) {
                  if (data0.interval_seconds !== void 0) {
                    let data2 = data0.interval_seconds;
                    const _errs6 = errors;
                    if (!(typeof data2 == "number" && (!(data2 % 1) && !isNaN(data2)) && isFinite(data2))) {
                      validate70.errors = [{ instancePath: instancePath + "/backups/interval_seconds", schemaPath: "#/$defs/BackupStatus/properties/interval_seconds/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                      return false;
                    }
                    if (errors === _errs6) {
                      if (typeof data2 == "number" && isFinite(data2)) {
                        if (data2 < 0 || isNaN(data2)) {
                          validate70.errors = [{ instancePath: instancePath + "/backups/interval_seconds", schemaPath: "#/$defs/BackupStatus/properties/interval_seconds/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                          return false;
                        }
                      }
                    }
                    var valid2 = _errs6 === errors;
                  } else {
                    var valid2 = true;
                  }
                  if (valid2) {
                    if (data0.keep !== void 0) {
                      let data3 = data0.keep;
                      const _errs8 = errors;
                      if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3))) {
                        validate70.errors = [{ instancePath: instancePath + "/backups/keep", schemaPath: "#/$defs/BackupStatus/properties/keep/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      if (errors === _errs8) {
                        if (typeof data3 == "number" && isFinite(data3)) {
                          if (data3 < 0 || isNaN(data3)) {
                            validate70.errors = [{ instancePath: instancePath + "/backups/keep", schemaPath: "#/$defs/BackupStatus/properties/keep/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                            return false;
                          }
                        }
                      }
                      var valid2 = _errs8 === errors;
                    } else {
                      var valid2 = true;
                    }
                    if (valid2) {
                      if (data0.last_backup_at !== void 0) {
                        let data4 = data0.last_backup_at;
                        const _errs10 = errors;
                        if (typeof data4 !== "string" && data4 !== null) {
                          validate70.errors = [{ instancePath: instancePath + "/backups/last_backup_at", schemaPath: "#/$defs/BackupStatus/properties/last_backup_at/type", keyword: "type", params: { type: schema102.properties.last_backup_at.type }, message: "must be string,null" }];
                          return false;
                        }
                        var valid2 = _errs10 === errors;
                      } else {
                        var valid2 = true;
                      }
                      if (valid2) {
                        if (data0.last_error !== void 0) {
                          let data5 = data0.last_error;
                          const _errs12 = errors;
                          if (typeof data5 !== "string" && data5 !== null) {
                            validate70.errors = [{ instancePath: instancePath + "/backups/last_error", schemaPath: "#/$defs/BackupStatus/properties/last_error/type", keyword: "type", params: { type: schema102.properties.last_error.type }, message: "must be string,null" }];
                            return false;
                          }
                          var valid2 = _errs12 === errors;
                        } else {
                          var valid2 = true;
                        }
                      }
                    }
                  }
                }
              }
            } else {
              validate70.errors = [{ instancePath: instancePath + "/backups", schemaPath: "#/$defs/BackupStatus/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
              return false;
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.instance_id !== void 0) {
            let data6 = data.instance_id;
            const _errs14 = errors;
            if (typeof data6 !== "string" && data6 !== null) {
              validate70.errors = [{ instancePath: instancePath + "/instance_id", schemaPath: "#/properties/instance_id/type", keyword: "type", params: { type: schema101.properties.instance_id.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs14 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.reachability !== void 0) {
              const _errs16 = errors;
              if (!validate71(data.reachability, { instancePath: instancePath + "/reachability", parentData: data, parentDataProperty: "reachability", rootData, dynamicAnchors })) {
                vErrors = vErrors === null ? validate71.errors : vErrors.concat(validate71.errors);
                errors = vErrors.length;
              }
              var valid0 = _errs16 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.setup_required !== void 0) {
                const _errs17 = errors;
                if (typeof data.setup_required !== "boolean") {
                  validate70.errors = [{ instancePath: instancePath + "/setup_required", schemaPath: "#/properties/setup_required/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                  return false;
                }
                var valid0 = _errs17 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.started_at !== void 0) {
                  const _errs19 = errors;
                  if (typeof data.started_at !== "string") {
                    validate70.errors = [{ instancePath: instancePath + "/started_at", schemaPath: "#/properties/started_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                  var valid0 = _errs19 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.storage !== void 0) {
                    const _errs21 = errors;
                    if (!validate73(data.storage, { instancePath: instancePath + "/storage", parentData: data, parentDataProperty: "storage", rootData, dynamicAnchors })) {
                      vErrors = vErrors === null ? validate73.errors : vErrors.concat(validate73.errors);
                      errors = vErrors.length;
                    }
                    var valid0 = _errs21 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.tls !== void 0) {
                      let data11 = data.tls;
                      const _errs22 = errors;
                      const _errs23 = errors;
                      if (errors === _errs23) {
                        if (data11 && typeof data11 == "object" && !Array.isArray(data11)) {
                          let missing2;
                          if (data11.fingerprint_sha256 === void 0 && (missing2 = "fingerprint_sha256") || data11.self_signed === void 0 && (missing2 = "self_signed")) {
                            validate70.errors = [{ instancePath: instancePath + "/tls", schemaPath: "#/$defs/TlsStatus/required", keyword: "required", params: { missingProperty: missing2 }, message: "must have required property '" + missing2 + "'" }];
                            return false;
                          } else {
                            if (data11.fingerprint_sha256 !== void 0) {
                              const _errs25 = errors;
                              if (typeof data11.fingerprint_sha256 !== "string") {
                                validate70.errors = [{ instancePath: instancePath + "/tls/fingerprint_sha256", schemaPath: "#/$defs/TlsStatus/properties/fingerprint_sha256/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                return false;
                              }
                              var valid4 = _errs25 === errors;
                            } else {
                              var valid4 = true;
                            }
                            if (valid4) {
                              if (data11.self_signed !== void 0) {
                                const _errs27 = errors;
                                if (typeof data11.self_signed !== "boolean") {
                                  validate70.errors = [{ instancePath: instancePath + "/tls/self_signed", schemaPath: "#/$defs/TlsStatus/properties/self_signed/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                                  return false;
                                }
                                var valid4 = _errs27 === errors;
                              } else {
                                var valid4 = true;
                              }
                            }
                          }
                        } else {
                          validate70.errors = [{ instancePath: instancePath + "/tls", schemaPath: "#/$defs/TlsStatus/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                          return false;
                        }
                      }
                      var valid0 = _errs22 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.version !== void 0) {
                        const _errs29 = errors;
                        if (typeof data.version !== "string") {
                          validate70.errors = [{ instancePath: instancePath + "/version", schemaPath: "#/properties/version/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                          return false;
                        }
                        var valid0 = _errs29 === errors;
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
      validate70.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate70.errors = vErrors;
  return errors === 0;
}
validate70.evaluated = { "props": { "backups": true, "instance_id": true, "reachability": true, "setup_required": true, "started_at": true, "storage": true, "tls": true, "version": true }, "dynamicProps": false, "dynamicItems": false };
var isInstanceStatusUpdate = validate75;
var schema110 = { "description": "Automatic backups.", "properties": { "enabled": { "type": "boolean" }, "interval_seconds": { "format": "uint64", "minimum": 0, "type": "integer" }, "keep": { "description": "How many backups are kept.", "format": "uint32", "minimum": 0, "type": "integer" }, "last_backup_at": { "type": ["string", "null"] }, "last_error": { "type": ["string", "null"] } }, "required": ["enabled", "interval_seconds", "keep", "last_backup_at", "last_error"], "type": "object" };
var schema111 = { "description": "The current reachability, as the server holds it.", "properties": { "confirmed_at": { "description": "When a connection from outside this network was observed.", "type": ["string", "null"] }, "external_ip": { "description": "Only ever what the router reported.", "type": ["string", "null"] }, "gateway_ip": { "type": ["string", "null"] }, "lan_ip": { "type": ["string", "null"] }, "last_error": { "type": ["string", "null"] }, "lease_expires_at": { "type": ["string", "null"] }, "method": { "description": '`"upnp"`, `"nat-pmp"` or `"pcp"`.', "type": ["string", "null"] }, "next_retry_at": { "type": ["string", "null"] }, "port": { "format": "uint16", "maximum": 65535, "minimum": 0, "type": "integer" }, "state": { "$ref": "#/$defs/ReachabilityState" } }, "required": ["state", "method", "external_ip", "gateway_ip", "lan_ip", "port", "lease_expires_at", "next_retry_at", "last_error", "confirmed_at"], "type": "object" };
function validate76(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate76.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.state === void 0 && (missing0 = "state") || data.method === void 0 && (missing0 = "method") || data.external_ip === void 0 && (missing0 = "external_ip") || data.gateway_ip === void 0 && (missing0 = "gateway_ip") || data.lan_ip === void 0 && (missing0 = "lan_ip") || data.port === void 0 && (missing0 = "port") || data.lease_expires_at === void 0 && (missing0 = "lease_expires_at") || data.next_retry_at === void 0 && (missing0 = "next_retry_at") || data.last_error === void 0 && (missing0 = "last_error") || data.confirmed_at === void 0 && (missing0 = "confirmed_at")) {
        validate76.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.confirmed_at !== void 0) {
          let data0 = data.confirmed_at;
          const _errs1 = errors;
          if (typeof data0 !== "string" && data0 !== null) {
            validate76.errors = [{ instancePath: instancePath + "/confirmed_at", schemaPath: "#/properties/confirmed_at/type", keyword: "type", params: { type: schema111.properties.confirmed_at.type }, message: "must be string,null" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.external_ip !== void 0) {
            let data1 = data.external_ip;
            const _errs3 = errors;
            if (typeof data1 !== "string" && data1 !== null) {
              validate76.errors = [{ instancePath: instancePath + "/external_ip", schemaPath: "#/properties/external_ip/type", keyword: "type", params: { type: schema111.properties.external_ip.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.gateway_ip !== void 0) {
              let data2 = data.gateway_ip;
              const _errs5 = errors;
              if (typeof data2 !== "string" && data2 !== null) {
                validate76.errors = [{ instancePath: instancePath + "/gateway_ip", schemaPath: "#/properties/gateway_ip/type", keyword: "type", params: { type: schema111.properties.gateway_ip.type }, message: "must be string,null" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.lan_ip !== void 0) {
                let data3 = data.lan_ip;
                const _errs7 = errors;
                if (typeof data3 !== "string" && data3 !== null) {
                  validate76.errors = [{ instancePath: instancePath + "/lan_ip", schemaPath: "#/properties/lan_ip/type", keyword: "type", params: { type: schema111.properties.lan_ip.type }, message: "must be string,null" }];
                  return false;
                }
                var valid0 = _errs7 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.last_error !== void 0) {
                  let data4 = data.last_error;
                  const _errs9 = errors;
                  if (typeof data4 !== "string" && data4 !== null) {
                    validate76.errors = [{ instancePath: instancePath + "/last_error", schemaPath: "#/properties/last_error/type", keyword: "type", params: { type: schema111.properties.last_error.type }, message: "must be string,null" }];
                    return false;
                  }
                  var valid0 = _errs9 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.lease_expires_at !== void 0) {
                    let data5 = data.lease_expires_at;
                    const _errs11 = errors;
                    if (typeof data5 !== "string" && data5 !== null) {
                      validate76.errors = [{ instancePath: instancePath + "/lease_expires_at", schemaPath: "#/properties/lease_expires_at/type", keyword: "type", params: { type: schema111.properties.lease_expires_at.type }, message: "must be string,null" }];
                      return false;
                    }
                    var valid0 = _errs11 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.method !== void 0) {
                      let data6 = data.method;
                      const _errs13 = errors;
                      if (typeof data6 !== "string" && data6 !== null) {
                        validate76.errors = [{ instancePath: instancePath + "/method", schemaPath: "#/properties/method/type", keyword: "type", params: { type: schema111.properties.method.type }, message: "must be string,null" }];
                        return false;
                      }
                      var valid0 = _errs13 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.next_retry_at !== void 0) {
                        let data7 = data.next_retry_at;
                        const _errs15 = errors;
                        if (typeof data7 !== "string" && data7 !== null) {
                          validate76.errors = [{ instancePath: instancePath + "/next_retry_at", schemaPath: "#/properties/next_retry_at/type", keyword: "type", params: { type: schema111.properties.next_retry_at.type }, message: "must be string,null" }];
                          return false;
                        }
                        var valid0 = _errs15 === errors;
                      } else {
                        var valid0 = true;
                      }
                      if (valid0) {
                        if (data.port !== void 0) {
                          let data8 = data.port;
                          const _errs17 = errors;
                          if (!(typeof data8 == "number" && (!(data8 % 1) && !isNaN(data8)) && isFinite(data8))) {
                            validate76.errors = [{ instancePath: instancePath + "/port", schemaPath: "#/properties/port/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                            return false;
                          }
                          if (errors === _errs17) {
                            if (typeof data8 == "number" && isFinite(data8)) {
                              if (data8 > 65535 || isNaN(data8)) {
                                validate76.errors = [{ instancePath: instancePath + "/port", schemaPath: "#/properties/port/maximum", keyword: "maximum", params: { comparison: "<=", limit: 65535 }, message: "must be <= 65535" }];
                                return false;
                              } else {
                                if (data8 < 0 || isNaN(data8)) {
                                  validate76.errors = [{ instancePath: instancePath + "/port", schemaPath: "#/properties/port/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                  return false;
                                }
                              }
                            }
                          }
                          var valid0 = _errs17 === errors;
                        } else {
                          var valid0 = true;
                        }
                        if (valid0) {
                          if (data.state !== void 0) {
                            let data9 = data.state;
                            const _errs19 = errors;
                            const _errs21 = errors;
                            let valid2 = false;
                            let passing0 = null;
                            const _errs22 = errors;
                            if (typeof data9 !== "string") {
                              const err0 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                              if (vErrors === null) {
                                vErrors = [err0];
                              } else {
                                vErrors.push(err0);
                              }
                              errors++;
                            }
                            if ("off" !== data9) {
                              const err1 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/0/const", keyword: "const", params: { allowedValue: "off" }, message: "must be equal to constant" };
                              if (vErrors === null) {
                                vErrors = [err1];
                              } else {
                                vErrors.push(err1);
                              }
                              errors++;
                            }
                            var _valid0 = _errs22 === errors;
                            if (_valid0) {
                              valid2 = true;
                              passing0 = 0;
                            }
                            const _errs24 = errors;
                            if (typeof data9 !== "string") {
                              const err2 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/1/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                              if (vErrors === null) {
                                vErrors = [err2];
                              } else {
                                vErrors.push(err2);
                              }
                              errors++;
                            }
                            if ("asking" !== data9) {
                              const err3 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/1/const", keyword: "const", params: { allowedValue: "asking" }, message: "must be equal to constant" };
                              if (vErrors === null) {
                                vErrors = [err3];
                              } else {
                                vErrors.push(err3);
                              }
                              errors++;
                            }
                            var _valid0 = _errs24 === errors;
                            if (_valid0 && valid2) {
                              valid2 = false;
                              passing0 = [passing0, 1];
                            } else {
                              if (_valid0) {
                                valid2 = true;
                                passing0 = 1;
                              }
                              const _errs26 = errors;
                              if (typeof data9 !== "string") {
                                const err4 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/2/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                if (vErrors === null) {
                                  vErrors = [err4];
                                } else {
                                  vErrors.push(err4);
                                }
                                errors++;
                              }
                              if ("open" !== data9) {
                                const err5 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/2/const", keyword: "const", params: { allowedValue: "open" }, message: "must be equal to constant" };
                                if (vErrors === null) {
                                  vErrors = [err5];
                                } else {
                                  vErrors.push(err5);
                                }
                                errors++;
                              }
                              var _valid0 = _errs26 === errors;
                              if (_valid0 && valid2) {
                                valid2 = false;
                                passing0 = [passing0, 2];
                              } else {
                                if (_valid0) {
                                  valid2 = true;
                                  passing0 = 2;
                                }
                                const _errs28 = errors;
                                if (typeof data9 !== "string") {
                                  const err6 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/3/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                  if (vErrors === null) {
                                    vErrors = [err6];
                                  } else {
                                    vErrors.push(err6);
                                  }
                                  errors++;
                                }
                                if ("shared_address" !== data9) {
                                  const err7 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/3/const", keyword: "const", params: { allowedValue: "shared_address" }, message: "must be equal to constant" };
                                  if (vErrors === null) {
                                    vErrors = [err7];
                                  } else {
                                    vErrors.push(err7);
                                  }
                                  errors++;
                                }
                                var _valid0 = _errs28 === errors;
                                if (_valid0 && valid2) {
                                  valid2 = false;
                                  passing0 = [passing0, 3];
                                } else {
                                  if (_valid0) {
                                    valid2 = true;
                                    passing0 = 3;
                                  }
                                  const _errs30 = errors;
                                  if (typeof data9 !== "string") {
                                    const err8 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/4/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                    if (vErrors === null) {
                                      vErrors = [err8];
                                    } else {
                                      vErrors.push(err8);
                                    }
                                    errors++;
                                  }
                                  if ("refused" !== data9) {
                                    const err9 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/4/const", keyword: "const", params: { allowedValue: "refused" }, message: "must be equal to constant" };
                                    if (vErrors === null) {
                                      vErrors = [err9];
                                    } else {
                                      vErrors.push(err9);
                                    }
                                    errors++;
                                  }
                                  var _valid0 = _errs30 === errors;
                                  if (_valid0 && valid2) {
                                    valid2 = false;
                                    passing0 = [passing0, 4];
                                  } else {
                                    if (_valid0) {
                                      valid2 = true;
                                      passing0 = 4;
                                    }
                                    const _errs32 = errors;
                                    if (typeof data9 !== "string") {
                                      const err10 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/5/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                      if (vErrors === null) {
                                        vErrors = [err10];
                                      } else {
                                        vErrors.push(err10);
                                      }
                                      errors++;
                                    }
                                    if ("no_answer" !== data9) {
                                      const err11 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/5/const", keyword: "const", params: { allowedValue: "no_answer" }, message: "must be equal to constant" };
                                      if (vErrors === null) {
                                        vErrors = [err11];
                                      } else {
                                        vErrors.push(err11);
                                      }
                                      errors++;
                                    }
                                    var _valid0 = _errs32 === errors;
                                    if (_valid0 && valid2) {
                                      valid2 = false;
                                      passing0 = [passing0, 5];
                                    } else {
                                      if (_valid0) {
                                        valid2 = true;
                                        passing0 = 5;
                                      }
                                      const _errs34 = errors;
                                      if (typeof data9 !== "string") {
                                        const err12 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/6/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                        if (vErrors === null) {
                                          vErrors = [err12];
                                        } else {
                                          vErrors.push(err12);
                                        }
                                        errors++;
                                      }
                                      if ("direct" !== data9) {
                                        const err13 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/6/const", keyword: "const", params: { allowedValue: "direct" }, message: "must be equal to constant" };
                                        if (vErrors === null) {
                                          vErrors = [err13];
                                        } else {
                                          vErrors.push(err13);
                                        }
                                        errors++;
                                      }
                                      var _valid0 = _errs34 === errors;
                                      if (_valid0 && valid2) {
                                        valid2 = false;
                                        passing0 = [passing0, 6];
                                      } else {
                                        if (_valid0) {
                                          valid2 = true;
                                          passing0 = 6;
                                        }
                                        const _errs36 = errors;
                                        if (typeof data9 !== "string") {
                                          const err14 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/7/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                          if (vErrors === null) {
                                            vErrors = [err14];
                                          } else {
                                            vErrors.push(err14);
                                          }
                                          errors++;
                                        }
                                        if ("firewall_blocked" !== data9) {
                                          const err15 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf/7/const", keyword: "const", params: { allowedValue: "firewall_blocked" }, message: "must be equal to constant" };
                                          if (vErrors === null) {
                                            vErrors = [err15];
                                          } else {
                                            vErrors.push(err15);
                                          }
                                          errors++;
                                        }
                                        var _valid0 = _errs36 === errors;
                                        if (_valid0 && valid2) {
                                          valid2 = false;
                                          passing0 = [passing0, 7];
                                        } else {
                                          if (_valid0) {
                                            valid2 = true;
                                            passing0 = 7;
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                            if (!valid2) {
                              const err16 = { instancePath: instancePath + "/state", schemaPath: "#/$defs/ReachabilityState/oneOf", keyword: "oneOf", params: { passingSchemas: passing0 }, message: "must match exactly one schema in oneOf" };
                              if (vErrors === null) {
                                vErrors = [err16];
                              } else {
                                vErrors.push(err16);
                              }
                              errors++;
                              validate76.errors = vErrors;
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
                            var valid0 = _errs19 === errors;
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
      validate76.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate76.errors = vErrors;
  return errors === 0;
}
validate76.evaluated = { "props": { "confirmed_at": true, "external_ip": true, "gateway_ip": true, "lan_ip": true, "last_error": true, "lease_expires_at": true, "method": true, "next_retry_at": true, "port": true, "state": true }, "dynamicProps": false, "dynamicItems": false };
function validate78(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate78.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.enabled === void 0 && (missing0 = "enabled") || data.sqlite_encrypted === void 0 && (missing0 = "sqlite_encrypted") || data.files_encrypted === void 0 && (missing0 = "files_encrypted") || data.key_source === void 0 && (missing0 = "key_source") || data.protection === void 0 && (missing0 = "protection") || data.escrowed === void 0 && (missing0 = "escrowed")) {
        validate78.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.enabled !== void 0) {
          const _errs1 = errors;
          if (typeof data.enabled !== "boolean") {
            validate78.errors = [{ instancePath: instancePath + "/enabled", schemaPath: "#/properties/enabled/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.escrowed !== void 0) {
            const _errs3 = errors;
            if (typeof data.escrowed !== "boolean") {
              validate78.errors = [{ instancePath: instancePath + "/escrowed", schemaPath: "#/properties/escrowed/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.files_encrypted !== void 0) {
              const _errs5 = errors;
              if (typeof data.files_encrypted !== "boolean") {
                validate78.errors = [{ instancePath: instancePath + "/files_encrypted", schemaPath: "#/properties/files_encrypted/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.key_source !== void 0) {
                let data3 = data.key_source;
                const _errs7 = errors;
                const _errs8 = errors;
                let valid1 = false;
                const _errs9 = errors;
                const _errs11 = errors;
                let valid3 = false;
                let passing0 = null;
                const _errs12 = errors;
                if (typeof data3 !== "string") {
                  const err0 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                  if (vErrors === null) {
                    vErrors = [err0];
                  } else {
                    vErrors.push(err0);
                  }
                  errors++;
                }
                if ("keychain" !== data3) {
                  const err1 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf/0/const", keyword: "const", params: { allowedValue: "keychain" }, message: "must be equal to constant" };
                  if (vErrors === null) {
                    vErrors = [err1];
                  } else {
                    vErrors.push(err1);
                  }
                  errors++;
                }
                var _valid1 = _errs12 === errors;
                if (_valid1) {
                  valid3 = true;
                  passing0 = 0;
                }
                const _errs14 = errors;
                if (typeof data3 !== "string") {
                  const err2 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf/1/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                  if (vErrors === null) {
                    vErrors = [err2];
                  } else {
                    vErrors.push(err2);
                  }
                  errors++;
                }
                if ("systemd-creds" !== data3) {
                  const err3 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf/1/const", keyword: "const", params: { allowedValue: "systemd-creds" }, message: "must be equal to constant" };
                  if (vErrors === null) {
                    vErrors = [err3];
                  } else {
                    vErrors.push(err3);
                  }
                  errors++;
                }
                var _valid1 = _errs14 === errors;
                if (_valid1 && valid3) {
                  valid3 = false;
                  passing0 = [passing0, 1];
                } else {
                  if (_valid1) {
                    valid3 = true;
                    passing0 = 1;
                  }
                  const _errs16 = errors;
                  if (typeof data3 !== "string") {
                    const err4 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf/2/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err4];
                    } else {
                      vErrors.push(err4);
                    }
                    errors++;
                  }
                  if ("file" !== data3) {
                    const err5 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf/2/const", keyword: "const", params: { allowedValue: "file" }, message: "must be equal to constant" };
                    if (vErrors === null) {
                      vErrors = [err5];
                    } else {
                      vErrors.push(err5);
                    }
                    errors++;
                  }
                  var _valid1 = _errs16 === errors;
                  if (_valid1 && valid3) {
                    valid3 = false;
                    passing0 = [passing0, 2];
                  } else {
                    if (_valid1) {
                      valid3 = true;
                      passing0 = 2;
                    }
                    const _errs18 = errors;
                    if (typeof data3 !== "string") {
                      const err6 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf/3/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                      if (vErrors === null) {
                        vErrors = [err6];
                      } else {
                        vErrors.push(err6);
                      }
                      errors++;
                    }
                    if ("env" !== data3) {
                      const err7 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf/3/const", keyword: "const", params: { allowedValue: "env" }, message: "must be equal to constant" };
                      if (vErrors === null) {
                        vErrors = [err7];
                      } else {
                        vErrors.push(err7);
                      }
                      errors++;
                    }
                    var _valid1 = _errs18 === errors;
                    if (_valid1 && valid3) {
                      valid3 = false;
                      passing0 = [passing0, 3];
                    } else {
                      if (_valid1) {
                        valid3 = true;
                        passing0 = 3;
                      }
                    }
                  }
                }
                if (!valid3) {
                  const err8 = { instancePath: instancePath + "/key_source", schemaPath: "#/$defs/KeySource/oneOf", keyword: "oneOf", params: { passingSchemas: passing0 }, message: "must match exactly one schema in oneOf" };
                  if (vErrors === null) {
                    vErrors = [err8];
                  } else {
                    vErrors.push(err8);
                  }
                  errors++;
                } else {
                  errors = _errs11;
                  if (vErrors !== null) {
                    if (_errs11) {
                      vErrors.length = _errs11;
                    } else {
                      vErrors = null;
                    }
                  }
                }
                var _valid0 = _errs9 === errors;
                valid1 = valid1 || _valid0;
                const _errs20 = errors;
                if (data3 !== null) {
                  const err9 = { instancePath: instancePath + "/key_source", schemaPath: "#/properties/key_source/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                  if (vErrors === null) {
                    vErrors = [err9];
                  } else {
                    vErrors.push(err9);
                  }
                  errors++;
                }
                var _valid0 = _errs20 === errors;
                valid1 = valid1 || _valid0;
                if (!valid1) {
                  const err10 = { instancePath: instancePath + "/key_source", schemaPath: "#/properties/key_source/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                  if (vErrors === null) {
                    vErrors = [err10];
                  } else {
                    vErrors.push(err10);
                  }
                  errors++;
                  validate78.errors = vErrors;
                  return false;
                } else {
                  errors = _errs8;
                  if (vErrors !== null) {
                    if (_errs8) {
                      vErrors.length = _errs8;
                    } else {
                      vErrors = null;
                    }
                  }
                }
                var valid0 = _errs7 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.protection !== void 0) {
                  let data4 = data.protection;
                  const _errs22 = errors;
                  const _errs23 = errors;
                  let valid4 = false;
                  const _errs24 = errors;
                  const _errs26 = errors;
                  let valid6 = false;
                  let passing1 = null;
                  const _errs27 = errors;
                  if (typeof data4 !== "string") {
                    const err11 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err11];
                    } else {
                      vErrors.push(err11);
                    }
                    errors++;
                  }
                  if ("login" !== data4) {
                    const err12 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf/0/const", keyword: "const", params: { allowedValue: "login" }, message: "must be equal to constant" };
                    if (vErrors === null) {
                      vErrors = [err12];
                    } else {
                      vErrors.push(err12);
                    }
                    errors++;
                  }
                  var _valid3 = _errs27 === errors;
                  if (_valid3) {
                    valid6 = true;
                    passing1 = 0;
                  }
                  const _errs29 = errors;
                  if (typeof data4 !== "string") {
                    const err13 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf/1/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err13];
                    } else {
                      vErrors.push(err13);
                    }
                    errors++;
                  }
                  if ("tpm" !== data4) {
                    const err14 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf/1/const", keyword: "const", params: { allowedValue: "tpm" }, message: "must be equal to constant" };
                    if (vErrors === null) {
                      vErrors = [err14];
                    } else {
                      vErrors.push(err14);
                    }
                    errors++;
                  }
                  var _valid3 = _errs29 === errors;
                  if (_valid3 && valid6) {
                    valid6 = false;
                    passing1 = [passing1, 1];
                  } else {
                    if (_valid3) {
                      valid6 = true;
                      passing1 = 1;
                    }
                    const _errs31 = errors;
                    if (typeof data4 !== "string") {
                      const err15 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf/2/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                      if (vErrors === null) {
                        vErrors = [err15];
                      } else {
                        vErrors.push(err15);
                      }
                      errors++;
                    }
                    if ("machine" !== data4) {
                      const err16 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf/2/const", keyword: "const", params: { allowedValue: "machine" }, message: "must be equal to constant" };
                      if (vErrors === null) {
                        vErrors = [err16];
                      } else {
                        vErrors.push(err16);
                      }
                      errors++;
                    }
                    var _valid3 = _errs31 === errors;
                    if (_valid3 && valid6) {
                      valid6 = false;
                      passing1 = [passing1, 2];
                    } else {
                      if (_valid3) {
                        valid6 = true;
                        passing1 = 2;
                      }
                      const _errs33 = errors;
                      if (typeof data4 !== "string") {
                        const err17 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf/3/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                        if (vErrors === null) {
                          vErrors = [err17];
                        } else {
                          vErrors.push(err17);
                        }
                        errors++;
                      }
                      if ("same_disk" !== data4) {
                        const err18 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf/3/const", keyword: "const", params: { allowedValue: "same_disk" }, message: "must be equal to constant" };
                        if (vErrors === null) {
                          vErrors = [err18];
                        } else {
                          vErrors.push(err18);
                        }
                        errors++;
                      }
                      var _valid3 = _errs33 === errors;
                      if (_valid3 && valid6) {
                        valid6 = false;
                        passing1 = [passing1, 3];
                      } else {
                        if (_valid3) {
                          valid6 = true;
                          passing1 = 3;
                        }
                      }
                    }
                  }
                  if (!valid6) {
                    const err19 = { instancePath: instancePath + "/protection", schemaPath: "#/$defs/Protection/oneOf", keyword: "oneOf", params: { passingSchemas: passing1 }, message: "must match exactly one schema in oneOf" };
                    if (vErrors === null) {
                      vErrors = [err19];
                    } else {
                      vErrors.push(err19);
                    }
                    errors++;
                  } else {
                    errors = _errs26;
                    if (vErrors !== null) {
                      if (_errs26) {
                        vErrors.length = _errs26;
                      } else {
                        vErrors = null;
                      }
                    }
                  }
                  var _valid2 = _errs24 === errors;
                  valid4 = valid4 || _valid2;
                  const _errs35 = errors;
                  if (data4 !== null) {
                    const err20 = { instancePath: instancePath + "/protection", schemaPath: "#/properties/protection/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                    if (vErrors === null) {
                      vErrors = [err20];
                    } else {
                      vErrors.push(err20);
                    }
                    errors++;
                  }
                  var _valid2 = _errs35 === errors;
                  valid4 = valid4 || _valid2;
                  if (!valid4) {
                    const err21 = { instancePath: instancePath + "/protection", schemaPath: "#/properties/protection/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                    if (vErrors === null) {
                      vErrors = [err21];
                    } else {
                      vErrors.push(err21);
                    }
                    errors++;
                    validate78.errors = vErrors;
                    return false;
                  } else {
                    errors = _errs23;
                    if (vErrors !== null) {
                      if (_errs23) {
                        vErrors.length = _errs23;
                      } else {
                        vErrors = null;
                      }
                    }
                  }
                  var valid0 = _errs22 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.sqlite_encrypted !== void 0) {
                    const _errs37 = errors;
                    if (typeof data.sqlite_encrypted !== "boolean") {
                      validate78.errors = [{ instancePath: instancePath + "/sqlite_encrypted", schemaPath: "#/properties/sqlite_encrypted/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                      return false;
                    }
                    var valid0 = _errs37 === errors;
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
      validate78.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate78.errors = vErrors;
  return errors === 0;
}
validate78.evaluated = { "props": { "enabled": true, "escrowed": true, "files_encrypted": true, "key_source": true, "protection": true, "sqlite_encrypted": true }, "dynamicProps": false, "dynamicItems": false };
function validate75(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate75.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.reachability === void 0 && (missing0 = "reachability") || data.storage === void 0 && (missing0 = "storage") || data.backups === void 0 && (missing0 = "backups")) {
        validate75.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.backups !== void 0) {
          let data0 = data.backups;
          const _errs1 = errors;
          const _errs2 = errors;
          if (errors === _errs2) {
            if (data0 && typeof data0 == "object" && !Array.isArray(data0)) {
              let missing1;
              if (data0.enabled === void 0 && (missing1 = "enabled") || data0.interval_seconds === void 0 && (missing1 = "interval_seconds") || data0.keep === void 0 && (missing1 = "keep") || data0.last_backup_at === void 0 && (missing1 = "last_backup_at") || data0.last_error === void 0 && (missing1 = "last_error")) {
                validate75.errors = [{ instancePath: instancePath + "/backups", schemaPath: "#/$defs/BackupStatus/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                return false;
              } else {
                if (data0.enabled !== void 0) {
                  const _errs4 = errors;
                  if (typeof data0.enabled !== "boolean") {
                    validate75.errors = [{ instancePath: instancePath + "/backups/enabled", schemaPath: "#/$defs/BackupStatus/properties/enabled/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                    return false;
                  }
                  var valid2 = _errs4 === errors;
                } else {
                  var valid2 = true;
                }
                if (valid2) {
                  if (data0.interval_seconds !== void 0) {
                    let data2 = data0.interval_seconds;
                    const _errs6 = errors;
                    if (!(typeof data2 == "number" && (!(data2 % 1) && !isNaN(data2)) && isFinite(data2))) {
                      validate75.errors = [{ instancePath: instancePath + "/backups/interval_seconds", schemaPath: "#/$defs/BackupStatus/properties/interval_seconds/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                      return false;
                    }
                    if (errors === _errs6) {
                      if (typeof data2 == "number" && isFinite(data2)) {
                        if (data2 < 0 || isNaN(data2)) {
                          validate75.errors = [{ instancePath: instancePath + "/backups/interval_seconds", schemaPath: "#/$defs/BackupStatus/properties/interval_seconds/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                          return false;
                        }
                      }
                    }
                    var valid2 = _errs6 === errors;
                  } else {
                    var valid2 = true;
                  }
                  if (valid2) {
                    if (data0.keep !== void 0) {
                      let data3 = data0.keep;
                      const _errs8 = errors;
                      if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3))) {
                        validate75.errors = [{ instancePath: instancePath + "/backups/keep", schemaPath: "#/$defs/BackupStatus/properties/keep/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      if (errors === _errs8) {
                        if (typeof data3 == "number" && isFinite(data3)) {
                          if (data3 < 0 || isNaN(data3)) {
                            validate75.errors = [{ instancePath: instancePath + "/backups/keep", schemaPath: "#/$defs/BackupStatus/properties/keep/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                            return false;
                          }
                        }
                      }
                      var valid2 = _errs8 === errors;
                    } else {
                      var valid2 = true;
                    }
                    if (valid2) {
                      if (data0.last_backup_at !== void 0) {
                        let data4 = data0.last_backup_at;
                        const _errs10 = errors;
                        if (typeof data4 !== "string" && data4 !== null) {
                          validate75.errors = [{ instancePath: instancePath + "/backups/last_backup_at", schemaPath: "#/$defs/BackupStatus/properties/last_backup_at/type", keyword: "type", params: { type: schema110.properties.last_backup_at.type }, message: "must be string,null" }];
                          return false;
                        }
                        var valid2 = _errs10 === errors;
                      } else {
                        var valid2 = true;
                      }
                      if (valid2) {
                        if (data0.last_error !== void 0) {
                          let data5 = data0.last_error;
                          const _errs12 = errors;
                          if (typeof data5 !== "string" && data5 !== null) {
                            validate75.errors = [{ instancePath: instancePath + "/backups/last_error", schemaPath: "#/$defs/BackupStatus/properties/last_error/type", keyword: "type", params: { type: schema110.properties.last_error.type }, message: "must be string,null" }];
                            return false;
                          }
                          var valid2 = _errs12 === errors;
                        } else {
                          var valid2 = true;
                        }
                      }
                    }
                  }
                }
              }
            } else {
              validate75.errors = [{ instancePath: instancePath + "/backups", schemaPath: "#/$defs/BackupStatus/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
              return false;
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.reachability !== void 0) {
            const _errs14 = errors;
            if (!validate76(data.reachability, { instancePath: instancePath + "/reachability", parentData: data, parentDataProperty: "reachability", rootData, dynamicAnchors })) {
              vErrors = vErrors === null ? validate76.errors : vErrors.concat(validate76.errors);
              errors = vErrors.length;
            }
            var valid0 = _errs14 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.storage !== void 0) {
              const _errs15 = errors;
              if (!validate78(data.storage, { instancePath: instancePath + "/storage", parentData: data, parentDataProperty: "storage", rootData, dynamicAnchors })) {
                vErrors = vErrors === null ? validate78.errors : vErrors.concat(validate78.errors);
                errors = vErrors.length;
              }
              var valid0 = _errs15 === errors;
            } else {
              var valid0 = true;
            }
          }
        }
      }
    } else {
      validate75.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate75.errors = vErrors;
  return errors === 0;
}
validate75.evaluated = { "props": { "backups": true, "reachability": true, "storage": true }, "dynamicProps": false, "dynamicItems": false };
var isInviteAcceptResponse = validate80;
var schema117 = { "description": "The guild card returned after successfully accepting an invite.", "properties": { "created_at": { "type": "string" }, "default_channel_id": { "description": "First usable channel for post-join navigation.", "type": ["string", "null"] }, "description": { "type": ["string", "null"] }, "icon_hash": { "type": ["string", "null"] }, "id": { "type": "string" }, "member_count": { "format": "uint32", "maximum": 4294967295, "minimum": 0, "type": "integer" }, "name": { "type": "string" }, "owner_id": { "type": "string" } }, "required": ["id", "name", "description", "icon_hash", "owner_id", "created_at", "default_channel_id", "member_count"], "type": "object" };
function validate80(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate80.evaluated;
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
        validate80.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.guild !== void 0) {
          let data0 = data.guild;
          const _errs2 = errors;
          if (errors === _errs2) {
            if (data0 && typeof data0 == "object" && !Array.isArray(data0)) {
              let missing1;
              if (data0.id === void 0 && (missing1 = "id") || data0.name === void 0 && (missing1 = "name") || data0.description === void 0 && (missing1 = "description") || data0.icon_hash === void 0 && (missing1 = "icon_hash") || data0.owner_id === void 0 && (missing1 = "owner_id") || data0.created_at === void 0 && (missing1 = "created_at") || data0.default_channel_id === void 0 && (missing1 = "default_channel_id") || data0.member_count === void 0 && (missing1 = "member_count")) {
                validate80.errors = [{ instancePath: instancePath + "/guild", schemaPath: "#/$defs/InviteAcceptGuild/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                return false;
              } else {
                if (data0.created_at !== void 0) {
                  const _errs4 = errors;
                  if (typeof data0.created_at !== "string") {
                    validate80.errors = [{ instancePath: instancePath + "/guild/created_at", schemaPath: "#/$defs/InviteAcceptGuild/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                      validate80.errors = [{ instancePath: instancePath + "/guild/default_channel_id", schemaPath: "#/$defs/InviteAcceptGuild/properties/default_channel_id/type", keyword: "type", params: { type: schema117.properties.default_channel_id.type }, message: "must be string,null" }];
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
                        validate80.errors = [{ instancePath: instancePath + "/guild/description", schemaPath: "#/$defs/InviteAcceptGuild/properties/description/type", keyword: "type", params: { type: schema117.properties.description.type }, message: "must be string,null" }];
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
                          validate80.errors = [{ instancePath: instancePath + "/guild/icon_hash", schemaPath: "#/$defs/InviteAcceptGuild/properties/icon_hash/type", keyword: "type", params: { type: schema117.properties.icon_hash.type }, message: "must be string,null" }];
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
                            validate80.errors = [{ instancePath: instancePath + "/guild/id", schemaPath: "#/$defs/InviteAcceptGuild/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                              validate80.errors = [{ instancePath: instancePath + "/guild/member_count", schemaPath: "#/$defs/InviteAcceptGuild/properties/member_count/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                              return false;
                            }
                            if (errors === _errs14) {
                              if (typeof data6 == "number" && isFinite(data6)) {
                                if (data6 > 4294967295 || isNaN(data6)) {
                                  validate80.errors = [{ instancePath: instancePath + "/guild/member_count", schemaPath: "#/$defs/InviteAcceptGuild/properties/member_count/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" }];
                                  return false;
                                } else {
                                  if (data6 < 0 || isNaN(data6)) {
                                    validate80.errors = [{ instancePath: instancePath + "/guild/member_count", schemaPath: "#/$defs/InviteAcceptGuild/properties/member_count/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
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
                                validate80.errors = [{ instancePath: instancePath + "/guild/name", schemaPath: "#/$defs/InviteAcceptGuild/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                  validate80.errors = [{ instancePath: instancePath + "/guild/owner_id", schemaPath: "#/$defs/InviteAcceptGuild/properties/owner_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
              validate80.errors = [{ instancePath: instancePath + "/guild", schemaPath: "#/$defs/InviteAcceptGuild/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
              return false;
            }
          }
        }
      }
    } else {
      validate80.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate80.errors = vErrors;
  return errors === 0;
}
validate80.evaluated = { "props": { "guild": true }, "dynamicProps": false, "dynamicItems": false };
var isInvitePreview = validate81;
var schema118 = { "$defs": { "InviteFace": { "description": "One of up to three members shown on an invite card: only the first\ngrapheme of the display name and the avatar hue. No names, ids or images.", "properties": { "hue": { "format": "int16", "maximum": 359, "minimum": 0, "type": "integer" }, "initial": { "type": "string" } }, "required": ["initial", "hue"], "type": "object" }, "InviteGuildPreview": { "description": "The guild card embedded in `GET /invites/{code}`.", "properties": { "hue": { "default": null, "description": "The server's color as a hue, 0-359; null when unset. Always sent by this\nserver; absent from older ones.", "format": "int16", "maximum": 359, "minimum": 0, "type": ["integer", "null"] }, "icon_hash": { "type": ["string", "null"] }, "id": { "type": "string" }, "member_count": { "format": "uint32", "maximum": 4294967295, "minimum": 0, "type": "integer" }, "name": { "type": "string" }, "online_count": { "default": 0, "description": "Members online now. Always sent by this server; absent from older ones.", "format": "uint32", "maximum": 4294967295, "minimum": 0, "type": "integer" } }, "required": ["id", "name", "icon_hash", "member_count"], "type": "object" }, "InviteInstance": { "description": "What the joining client needs to know about the instance before any\naccount work (spec \xA76.1, \xA73.12).", "properties": { "credential_version": { "description": "2 on servers with one-password sign-up.", "format": "uint8", "maximum": 255, "minimum": 0, "type": "integer" }, "name": { "type": "string" }, "registration_mode": { "$ref": "#/$defs/RegistrationMode" }, "require_email": { "type": "boolean" }, "version": { "type": "string" } }, "required": ["name", "version", "credential_version", "registration_mode", "require_email"], "type": "object" }, "InviteJoinGate": { "description": "What joining asks of a newcomer, when the server's owner has turned the\nverification gate on. The questions are the prompts only; the expected\nanswers never leave the server.", "properties": { "questions": { "description": "Questions to answer, in order. Empty when the gate asks none.", "items": { "type": "string" }, "type": "array" }, "require_ack": { "description": "The newcomer must tick an acknowledgment of the server's rules.", "type": "boolean" } }, "required": ["require_ack", "questions"], "type": "object" }, "RegistrationMode": { "description": "Who can create an account on an instance. The same spelling as the\n`[auth] registration_mode` config value.", "enum": ["open", "invite_only"], "type": "string" } }, "$id": "urn:paracord:contract:InvitePreview", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "`GET /invites/{code}`: public invite resolution. `guild` is null when the\ninvite's channel no longer resolves to a guild. `join_gate` is null unless\nthe owner enabled one \u2014 which is what lets the invite page ask a newcomer\nfor nothing at all in the ordinary case.", "properties": { "code": { "type": "string" }, "expires_at": { "default": null, "description": "RFC 3339; null when the invite never expires.", "type": ["string", "null"] }, "faces": { "default": [], "description": "Up to three members, online first, then most recently joined.", "items": { "$ref": "#/$defs/InviteFace" }, "type": "array" }, "guild": { "anyOf": [{ "$ref": "#/$defs/InviteGuildPreview" }, { "type": "null" }] }, "instance": { "$ref": "#/$defs/InviteInstance" }, "join_gate": { "anyOf": [{ "$ref": "#/$defs/InviteJoinGate" }, { "type": "null" }], "description": "Present only when the owner enabled a gate. Absent is the ordinary case,\nand it is also what a server that predates this field sends \u2014 so a\nclient can still open its invites; such a server enforces its gate on\naccept and says what is missing." } }, "required": ["code", "guild"], "title": "InvitePreview", "type": "object" };
var schema120 = { "description": "The guild card embedded in `GET /invites/{code}`.", "properties": { "hue": { "default": null, "description": "The server's color as a hue, 0-359; null when unset. Always sent by this\nserver; absent from older ones.", "format": "int16", "maximum": 359, "minimum": 0, "type": ["integer", "null"] }, "icon_hash": { "type": ["string", "null"] }, "id": { "type": "string" }, "member_count": { "format": "uint32", "maximum": 4294967295, "minimum": 0, "type": "integer" }, "name": { "type": "string" }, "online_count": { "default": 0, "description": "Members online now. Always sent by this server; absent from older ones.", "format": "uint32", "maximum": 4294967295, "minimum": 0, "type": "integer" } }, "required": ["id", "name", "icon_hash", "member_count"], "type": "object" };
var schema122 = { "description": "Who can create an account on an instance. The same spelling as the\n`[auth] registration_mode` config value.", "enum": ["open", "invite_only"], "type": "string" };
function validate82(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate82.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.name === void 0 && (missing0 = "name") || data.version === void 0 && (missing0 = "version") || data.credential_version === void 0 && (missing0 = "credential_version") || data.registration_mode === void 0 && (missing0 = "registration_mode") || data.require_email === void 0 && (missing0 = "require_email")) {
        validate82.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.credential_version !== void 0) {
          let data0 = data.credential_version;
          const _errs1 = errors;
          if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)) && isFinite(data0))) {
            validate82.errors = [{ instancePath: instancePath + "/credential_version", schemaPath: "#/properties/credential_version/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
            return false;
          }
          if (errors === _errs1) {
            if (typeof data0 == "number" && isFinite(data0)) {
              if (data0 > 255 || isNaN(data0)) {
                validate82.errors = [{ instancePath: instancePath + "/credential_version", schemaPath: "#/properties/credential_version/maximum", keyword: "maximum", params: { comparison: "<=", limit: 255 }, message: "must be <= 255" }];
                return false;
              } else {
                if (data0 < 0 || isNaN(data0)) {
                  validate82.errors = [{ instancePath: instancePath + "/credential_version", schemaPath: "#/properties/credential_version/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                  return false;
                }
              }
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.name !== void 0) {
            const _errs3 = errors;
            if (typeof data.name !== "string") {
              validate82.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.registration_mode !== void 0) {
              let data2 = data.registration_mode;
              const _errs5 = errors;
              if (typeof data2 !== "string") {
                validate82.errors = [{ instancePath: instancePath + "/registration_mode", schemaPath: "#/$defs/RegistrationMode/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              if (!(data2 === "open" || data2 === "invite_only")) {
                validate82.errors = [{ instancePath: instancePath + "/registration_mode", schemaPath: "#/$defs/RegistrationMode/enum", keyword: "enum", params: { allowedValues: schema122.enum }, message: "must be equal to one of the allowed values" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.require_email !== void 0) {
                const _errs8 = errors;
                if (typeof data.require_email !== "boolean") {
                  validate82.errors = [{ instancePath: instancePath + "/require_email", schemaPath: "#/properties/require_email/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                  return false;
                }
                var valid0 = _errs8 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.version !== void 0) {
                  const _errs10 = errors;
                  if (typeof data.version !== "string") {
                    validate82.errors = [{ instancePath: instancePath + "/version", schemaPath: "#/properties/version/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                  var valid0 = _errs10 === errors;
                } else {
                  var valid0 = true;
                }
              }
            }
          }
        }
      }
    } else {
      validate82.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate82.errors = vErrors;
  return errors === 0;
}
validate82.evaluated = { "props": { "credential_version": true, "name": true, "registration_mode": true, "require_email": true, "version": true }, "dynamicProps": false, "dynamicItems": false };
function validate81(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate81.evaluated;
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
        validate81.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.code !== void 0) {
          const _errs1 = errors;
          if (typeof data.code !== "string") {
            validate81.errors = [{ instancePath: instancePath + "/code", schemaPath: "#/properties/code/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.expires_at !== void 0) {
            let data1 = data.expires_at;
            const _errs3 = errors;
            if (typeof data1 !== "string" && data1 !== null) {
              validate81.errors = [{ instancePath: instancePath + "/expires_at", schemaPath: "#/properties/expires_at/type", keyword: "type", params: { type: schema118.properties.expires_at.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.faces !== void 0) {
              let data2 = data.faces;
              const _errs5 = errors;
              if (errors === _errs5) {
                if (Array.isArray(data2)) {
                  var valid1 = true;
                  const len0 = data2.length;
                  for (let i0 = 0; i0 < len0; i0++) {
                    let data3 = data2[i0];
                    const _errs7 = errors;
                    const _errs8 = errors;
                    if (errors === _errs8) {
                      if (data3 && typeof data3 == "object" && !Array.isArray(data3)) {
                        let missing1;
                        if (data3.initial === void 0 && (missing1 = "initial") || data3.hue === void 0 && (missing1 = "hue")) {
                          validate81.errors = [{ instancePath: instancePath + "/faces/" + i0, schemaPath: "#/$defs/InviteFace/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                          return false;
                        } else {
                          if (data3.hue !== void 0) {
                            let data4 = data3.hue;
                            const _errs10 = errors;
                            if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
                              validate81.errors = [{ instancePath: instancePath + "/faces/" + i0 + "/hue", schemaPath: "#/$defs/InviteFace/properties/hue/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                              return false;
                            }
                            if (errors === _errs10) {
                              if (typeof data4 == "number" && isFinite(data4)) {
                                if (data4 > 359 || isNaN(data4)) {
                                  validate81.errors = [{ instancePath: instancePath + "/faces/" + i0 + "/hue", schemaPath: "#/$defs/InviteFace/properties/hue/maximum", keyword: "maximum", params: { comparison: "<=", limit: 359 }, message: "must be <= 359" }];
                                  return false;
                                } else {
                                  if (data4 < 0 || isNaN(data4)) {
                                    validate81.errors = [{ instancePath: instancePath + "/faces/" + i0 + "/hue", schemaPath: "#/$defs/InviteFace/properties/hue/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                    return false;
                                  }
                                }
                              }
                            }
                            var valid3 = _errs10 === errors;
                          } else {
                            var valid3 = true;
                          }
                          if (valid3) {
                            if (data3.initial !== void 0) {
                              const _errs12 = errors;
                              if (typeof data3.initial !== "string") {
                                validate81.errors = [{ instancePath: instancePath + "/faces/" + i0 + "/initial", schemaPath: "#/$defs/InviteFace/properties/initial/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                return false;
                              }
                              var valid3 = _errs12 === errors;
                            } else {
                              var valid3 = true;
                            }
                          }
                        }
                      } else {
                        validate81.errors = [{ instancePath: instancePath + "/faces/" + i0, schemaPath: "#/$defs/InviteFace/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                        return false;
                      }
                    }
                    var valid1 = _errs7 === errors;
                    if (!valid1) {
                      break;
                    }
                  }
                } else {
                  validate81.errors = [{ instancePath: instancePath + "/faces", schemaPath: "#/properties/faces/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
                  return false;
                }
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.guild !== void 0) {
                let data6 = data.guild;
                const _errs14 = errors;
                const _errs15 = errors;
                let valid4 = false;
                const _errs16 = errors;
                const _errs17 = errors;
                if (errors === _errs17) {
                  if (data6 && typeof data6 == "object" && !Array.isArray(data6)) {
                    let missing2;
                    if (data6.id === void 0 && (missing2 = "id") || data6.name === void 0 && (missing2 = "name") || data6.icon_hash === void 0 && (missing2 = "icon_hash") || data6.member_count === void 0 && (missing2 = "member_count")) {
                      const err0 = { instancePath: instancePath + "/guild", schemaPath: "#/$defs/InviteGuildPreview/required", keyword: "required", params: { missingProperty: missing2 }, message: "must have required property '" + missing2 + "'" };
                      if (vErrors === null) {
                        vErrors = [err0];
                      } else {
                        vErrors.push(err0);
                      }
                      errors++;
                    } else {
                      if (data6.hue !== void 0) {
                        let data7 = data6.hue;
                        const _errs19 = errors;
                        if (!(typeof data7 == "number" && (!(data7 % 1) && !isNaN(data7)) && isFinite(data7)) && data7 !== null) {
                          const err1 = { instancePath: instancePath + "/guild/hue", schemaPath: "#/$defs/InviteGuildPreview/properties/hue/type", keyword: "type", params: { type: schema120.properties.hue.type }, message: "must be integer,null" };
                          if (vErrors === null) {
                            vErrors = [err1];
                          } else {
                            vErrors.push(err1);
                          }
                          errors++;
                        }
                        if (errors === _errs19) {
                          if (typeof data7 == "number" && isFinite(data7)) {
                            if (data7 > 359 || isNaN(data7)) {
                              const err2 = { instancePath: instancePath + "/guild/hue", schemaPath: "#/$defs/InviteGuildPreview/properties/hue/maximum", keyword: "maximum", params: { comparison: "<=", limit: 359 }, message: "must be <= 359" };
                              if (vErrors === null) {
                                vErrors = [err2];
                              } else {
                                vErrors.push(err2);
                              }
                              errors++;
                            } else {
                              if (data7 < 0 || isNaN(data7)) {
                                const err3 = { instancePath: instancePath + "/guild/hue", schemaPath: "#/$defs/InviteGuildPreview/properties/hue/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
                                if (vErrors === null) {
                                  vErrors = [err3];
                                } else {
                                  vErrors.push(err3);
                                }
                                errors++;
                              }
                            }
                          }
                        }
                        var valid6 = _errs19 === errors;
                      } else {
                        var valid6 = true;
                      }
                      if (valid6) {
                        if (data6.icon_hash !== void 0) {
                          let data8 = data6.icon_hash;
                          const _errs21 = errors;
                          if (typeof data8 !== "string" && data8 !== null) {
                            const err4 = { instancePath: instancePath + "/guild/icon_hash", schemaPath: "#/$defs/InviteGuildPreview/properties/icon_hash/type", keyword: "type", params: { type: schema120.properties.icon_hash.type }, message: "must be string,null" };
                            if (vErrors === null) {
                              vErrors = [err4];
                            } else {
                              vErrors.push(err4);
                            }
                            errors++;
                          }
                          var valid6 = _errs21 === errors;
                        } else {
                          var valid6 = true;
                        }
                        if (valid6) {
                          if (data6.id !== void 0) {
                            const _errs23 = errors;
                            if (typeof data6.id !== "string") {
                              const err5 = { instancePath: instancePath + "/guild/id", schemaPath: "#/$defs/InviteGuildPreview/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                              if (vErrors === null) {
                                vErrors = [err5];
                              } else {
                                vErrors.push(err5);
                              }
                              errors++;
                            }
                            var valid6 = _errs23 === errors;
                          } else {
                            var valid6 = true;
                          }
                          if (valid6) {
                            if (data6.member_count !== void 0) {
                              let data10 = data6.member_count;
                              const _errs25 = errors;
                              if (!(typeof data10 == "number" && (!(data10 % 1) && !isNaN(data10)) && isFinite(data10))) {
                                const err6 = { instancePath: instancePath + "/guild/member_count", schemaPath: "#/$defs/InviteGuildPreview/properties/member_count/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
                                if (vErrors === null) {
                                  vErrors = [err6];
                                } else {
                                  vErrors.push(err6);
                                }
                                errors++;
                              }
                              if (errors === _errs25) {
                                if (typeof data10 == "number" && isFinite(data10)) {
                                  if (data10 > 4294967295 || isNaN(data10)) {
                                    const err7 = { instancePath: instancePath + "/guild/member_count", schemaPath: "#/$defs/InviteGuildPreview/properties/member_count/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" };
                                    if (vErrors === null) {
                                      vErrors = [err7];
                                    } else {
                                      vErrors.push(err7);
                                    }
                                    errors++;
                                  } else {
                                    if (data10 < 0 || isNaN(data10)) {
                                      const err8 = { instancePath: instancePath + "/guild/member_count", schemaPath: "#/$defs/InviteGuildPreview/properties/member_count/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
                                      if (vErrors === null) {
                                        vErrors = [err8];
                                      } else {
                                        vErrors.push(err8);
                                      }
                                      errors++;
                                    }
                                  }
                                }
                              }
                              var valid6 = _errs25 === errors;
                            } else {
                              var valid6 = true;
                            }
                            if (valid6) {
                              if (data6.name !== void 0) {
                                const _errs27 = errors;
                                if (typeof data6.name !== "string") {
                                  const err9 = { instancePath: instancePath + "/guild/name", schemaPath: "#/$defs/InviteGuildPreview/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                  if (vErrors === null) {
                                    vErrors = [err9];
                                  } else {
                                    vErrors.push(err9);
                                  }
                                  errors++;
                                }
                                var valid6 = _errs27 === errors;
                              } else {
                                var valid6 = true;
                              }
                              if (valid6) {
                                if (data6.online_count !== void 0) {
                                  let data12 = data6.online_count;
                                  const _errs29 = errors;
                                  if (!(typeof data12 == "number" && (!(data12 % 1) && !isNaN(data12)) && isFinite(data12))) {
                                    const err10 = { instancePath: instancePath + "/guild/online_count", schemaPath: "#/$defs/InviteGuildPreview/properties/online_count/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
                                    if (vErrors === null) {
                                      vErrors = [err10];
                                    } else {
                                      vErrors.push(err10);
                                    }
                                    errors++;
                                  }
                                  if (errors === _errs29) {
                                    if (typeof data12 == "number" && isFinite(data12)) {
                                      if (data12 > 4294967295 || isNaN(data12)) {
                                        const err11 = { instancePath: instancePath + "/guild/online_count", schemaPath: "#/$defs/InviteGuildPreview/properties/online_count/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" };
                                        if (vErrors === null) {
                                          vErrors = [err11];
                                        } else {
                                          vErrors.push(err11);
                                        }
                                        errors++;
                                      } else {
                                        if (data12 < 0 || isNaN(data12)) {
                                          const err12 = { instancePath: instancePath + "/guild/online_count", schemaPath: "#/$defs/InviteGuildPreview/properties/online_count/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
                                          if (vErrors === null) {
                                            vErrors = [err12];
                                          } else {
                                            vErrors.push(err12);
                                          }
                                          errors++;
                                        }
                                      }
                                    }
                                  }
                                  var valid6 = _errs29 === errors;
                                } else {
                                  var valid6 = true;
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  } else {
                    const err13 = { instancePath: instancePath + "/guild", schemaPath: "#/$defs/InviteGuildPreview/type", keyword: "type", params: { type: "object" }, message: "must be object" };
                    if (vErrors === null) {
                      vErrors = [err13];
                    } else {
                      vErrors.push(err13);
                    }
                    errors++;
                  }
                }
                var _valid0 = _errs16 === errors;
                valid4 = valid4 || _valid0;
                if (_valid0) {
                  var props0 = {};
                  props0.hue = true;
                  props0.icon_hash = true;
                  props0.id = true;
                  props0.member_count = true;
                  props0.name = true;
                  props0.online_count = true;
                }
                const _errs31 = errors;
                if (data6 !== null) {
                  const err14 = { instancePath: instancePath + "/guild", schemaPath: "#/properties/guild/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                  if (vErrors === null) {
                    vErrors = [err14];
                  } else {
                    vErrors.push(err14);
                  }
                  errors++;
                }
                var _valid0 = _errs31 === errors;
                valid4 = valid4 || _valid0;
                if (!valid4) {
                  const err15 = { instancePath: instancePath + "/guild", schemaPath: "#/properties/guild/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                  if (vErrors === null) {
                    vErrors = [err15];
                  } else {
                    vErrors.push(err15);
                  }
                  errors++;
                  validate81.errors = vErrors;
                  return false;
                } else {
                  errors = _errs15;
                  if (vErrors !== null) {
                    if (_errs15) {
                      vErrors.length = _errs15;
                    } else {
                      vErrors = null;
                    }
                  }
                }
                var valid0 = _errs14 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.instance !== void 0) {
                  const _errs33 = errors;
                  if (!validate82(data.instance, { instancePath: instancePath + "/instance", parentData: data, parentDataProperty: "instance", rootData, dynamicAnchors })) {
                    vErrors = vErrors === null ? validate82.errors : vErrors.concat(validate82.errors);
                    errors = vErrors.length;
                  }
                  var valid0 = _errs33 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.join_gate !== void 0) {
                    let data14 = data.join_gate;
                    const _errs34 = errors;
                    const _errs35 = errors;
                    let valid7 = false;
                    const _errs36 = errors;
                    const _errs37 = errors;
                    if (errors === _errs37) {
                      if (data14 && typeof data14 == "object" && !Array.isArray(data14)) {
                        let missing3;
                        if (data14.require_ack === void 0 && (missing3 = "require_ack") || data14.questions === void 0 && (missing3 = "questions")) {
                          const err16 = { instancePath: instancePath + "/join_gate", schemaPath: "#/$defs/InviteJoinGate/required", keyword: "required", params: { missingProperty: missing3 }, message: "must have required property '" + missing3 + "'" };
                          if (vErrors === null) {
                            vErrors = [err16];
                          } else {
                            vErrors.push(err16);
                          }
                          errors++;
                        } else {
                          if (data14.questions !== void 0) {
                            let data15 = data14.questions;
                            const _errs39 = errors;
                            if (errors === _errs39) {
                              if (Array.isArray(data15)) {
                                var valid10 = true;
                                const len1 = data15.length;
                                for (let i1 = 0; i1 < len1; i1++) {
                                  const _errs41 = errors;
                                  if (typeof data15[i1] !== "string") {
                                    const err17 = { instancePath: instancePath + "/join_gate/questions/" + i1, schemaPath: "#/$defs/InviteJoinGate/properties/questions/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                    if (vErrors === null) {
                                      vErrors = [err17];
                                    } else {
                                      vErrors.push(err17);
                                    }
                                    errors++;
                                  }
                                  var valid10 = _errs41 === errors;
                                  if (!valid10) {
                                    break;
                                  }
                                }
                              } else {
                                const err18 = { instancePath: instancePath + "/join_gate/questions", schemaPath: "#/$defs/InviteJoinGate/properties/questions/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                                if (vErrors === null) {
                                  vErrors = [err18];
                                } else {
                                  vErrors.push(err18);
                                }
                                errors++;
                              }
                            }
                            var valid9 = _errs39 === errors;
                          } else {
                            var valid9 = true;
                          }
                          if (valid9) {
                            if (data14.require_ack !== void 0) {
                              const _errs43 = errors;
                              if (typeof data14.require_ack !== "boolean") {
                                const err19 = { instancePath: instancePath + "/join_gate/require_ack", schemaPath: "#/$defs/InviteJoinGate/properties/require_ack/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" };
                                if (vErrors === null) {
                                  vErrors = [err19];
                                } else {
                                  vErrors.push(err19);
                                }
                                errors++;
                              }
                              var valid9 = _errs43 === errors;
                            } else {
                              var valid9 = true;
                            }
                          }
                        }
                      } else {
                        const err20 = { instancePath: instancePath + "/join_gate", schemaPath: "#/$defs/InviteJoinGate/type", keyword: "type", params: { type: "object" }, message: "must be object" };
                        if (vErrors === null) {
                          vErrors = [err20];
                        } else {
                          vErrors.push(err20);
                        }
                        errors++;
                      }
                    }
                    var _valid1 = _errs36 === errors;
                    valid7 = valid7 || _valid1;
                    if (_valid1) {
                      var props1 = {};
                      props1.questions = true;
                      props1.require_ack = true;
                    }
                    const _errs45 = errors;
                    if (data14 !== null) {
                      const err21 = { instancePath: instancePath + "/join_gate", schemaPath: "#/properties/join_gate/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                      if (vErrors === null) {
                        vErrors = [err21];
                      } else {
                        vErrors.push(err21);
                      }
                      errors++;
                    }
                    var _valid1 = _errs45 === errors;
                    valid7 = valid7 || _valid1;
                    if (!valid7) {
                      const err22 = { instancePath: instancePath + "/join_gate", schemaPath: "#/properties/join_gate/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                      if (vErrors === null) {
                        vErrors = [err22];
                      } else {
                        vErrors.push(err22);
                      }
                      errors++;
                      validate81.errors = vErrors;
                      return false;
                    } else {
                      errors = _errs35;
                      if (vErrors !== null) {
                        if (_errs35) {
                          vErrors.length = _errs35;
                        } else {
                          vErrors = null;
                        }
                      }
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
    } else {
      validate81.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate81.errors = vErrors;
  return errors === 0;
}
validate81.evaluated = { "props": { "code": true, "expires_at": true, "faces": true, "guild": true, "instance": true, "join_gate": true }, "dynamicProps": false, "dynamicItems": false };
var isKeyBackup = validate84;
function validate84(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate84.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.public_key === void 0 && (missing0 = "public_key") || data.wrapped_key === void 0 && (missing0 = "wrapped_key") || data.wrap_alg === void 0 && (missing0 = "wrap_alg") || data.epoch === void 0 && (missing0 = "epoch") || data.recovery_confirmed === void 0 && (missing0 = "recovery_confirmed")) {
        validate84.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.epoch !== void 0) {
          let data0 = data.epoch;
          const _errs1 = errors;
          if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)) && isFinite(data0))) {
            validate84.errors = [{ instancePath: instancePath + "/epoch", schemaPath: "#/properties/epoch/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.public_key !== void 0) {
            const _errs3 = errors;
            if (typeof data.public_key !== "string") {
              validate84.errors = [{ instancePath: instancePath + "/public_key", schemaPath: "#/properties/public_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.recovery_confirmed !== void 0) {
              const _errs5 = errors;
              if (typeof data.recovery_confirmed !== "boolean") {
                validate84.errors = [{ instancePath: instancePath + "/recovery_confirmed", schemaPath: "#/properties/recovery_confirmed/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.wrap_alg !== void 0) {
                const _errs7 = errors;
                if (typeof data.wrap_alg !== "string") {
                  validate84.errors = [{ instancePath: instancePath + "/wrap_alg", schemaPath: "#/properties/wrap_alg/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid0 = _errs7 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.wrapped_key !== void 0) {
                  const _errs9 = errors;
                  if (typeof data.wrapped_key !== "string") {
                    validate84.errors = [{ instancePath: instancePath + "/wrapped_key", schemaPath: "#/properties/wrapped_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                  var valid0 = _errs9 === errors;
                } else {
                  var valid0 = true;
                }
              }
            }
          }
        }
      }
    } else {
      validate84.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate84.errors = vErrors;
  return errors === 0;
}
validate84.evaluated = { "props": { "epoch": true, "public_key": true, "recovery_confirmed": true, "wrap_alg": true, "wrapped_key": true }, "dynamicProps": false, "dynamicItems": false };
var isNewOwnerClaim = validate85;
var schema125 = { "$defs": { "IdentityProof": { "description": "A signature over a server challenge, proving possession of the identity key.", "properties": { "nonce": { "description": "The nonce `/auth/challenge` issued.", "type": "string" }, "signature": { "description": 'hex Ed25519 signature over\n`"<purpose>:" + nonce + ":" + timestamp + ":" + origin`, where purpose is\n`paracord/credential/v2/register` or `paracord/credential/v2/reset`.', "type": "string" }, "timestamp": { "description": "The timestamp `/auth/challenge` issued (Unix seconds).", "format": "int64", "type": "integer" } }, "required": ["nonce", "timestamp", "signature"], "type": "object" }, "InitialServerTemplate": { "description": "The first server a desktop host or a headless install creates at the claim.", "oneOf": [{ "const": "friends", "description": "Text channels `general`, `clips`, `plans`; voice channels `Lounge`,\n`Gaming` (spec \xA72.7).", "type": "string" }] }, "KdfParams": { "description": 'scrypt parameters as sent on the wire. Stored per credential as\n`"scrypt:<log_n>:<r>:<p>"` (see [`KdfParams::to_db_text`]).', "properties": { "alg": { "description": 'Always `"scrypt"`.', "type": "string" }, "log_n": { "description": "log2 of scrypt's N.", "format": "uint8", "maximum": 255, "minimum": 0, "type": "integer" }, "p": { "format": "uint32", "minimum": 0, "type": "integer" }, "r": { "format": "uint32", "minimum": 0, "type": "integer" } }, "required": ["alg", "log_n", "r", "p"], "type": "object" }, "NewCredential": { "description": "A freshly derived credential: what the server stores in place of a password.", "properties": { "auth_key": { "description": "b64url of the 32-byte HKDF output `paracord/credential/v2/auth`.", "type": "string" }, "kdf": { "$ref": "#/$defs/KdfParams" }, "salt": { "description": "b64url of 32 random bytes.", "type": "string" } }, "required": ["salt", "kdf", "auth_key"], "type": "object" }, "NewIdentity": { "description": "The identity as the server keeps it: the public key and the private key\nwrapped under the password-derived wrap key.", "properties": { "proof": { "$ref": "#/$defs/IdentityProof" }, "public_key": { "description": "hex of the 32-byte Ed25519 public key.", "type": "string" }, "wrap_alg": { "description": '`"aes256gcm-v2"` ([`WRAP_ALG_V2`]).', "type": "string" }, "wrapped_key": { "description": "b64url of `iv12 || ciphertext+tag` (12 + 48 bytes).", "type": "string" } }, "required": ["public_key", "wrapped_key", "wrap_alg", "proof"], "type": "object" }, "RegistrationMode": { "description": "Who can create an account on an instance. The same spelling as the\n`[auth] registration_mode` config value.", "enum": ["open", "invite_only"], "type": "string" } }, "$id": "urn:paracord:contract:NewOwnerClaim", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "The owner and first server a claim creates, without the claim token. The\ndesktop app's `host_claim` command takes this; its Rust side reads the token\nfrom the claim file and sends [`CredentialClaimRequest`].", "properties": { "credential": { "$ref": "#/$defs/NewCredential" }, "display_name": { "default": null, "type": ["string", "null"] }, "email": { "default": null, "type": ["string", "null"] }, "identity": { "$ref": "#/$defs/NewIdentity" }, "initial_space_hue": { "description": "The first server's color, 0-359.", "format": "int16", "maximum": 359, "minimum": 0, "type": "integer" }, "initial_space_icon": { "default": null, "type": ["string", "null"] }, "initial_space_name": { "type": "string" }, "initial_space_template": { "$ref": "#/$defs/InitialServerTemplate" }, "instance_name": { "type": "string" }, "registration_mode": { "anyOf": [{ "$ref": "#/$defs/RegistrationMode" }, { "type": "null" }], "default": null, "description": "Saved with the server when given; otherwise the config file's\n`[auth] registration_mode` stands." }, "username": { "type": "string" } }, "required": ["username", "instance_name", "initial_space_name", "initial_space_hue", "initial_space_template", "credential", "identity"], "title": "NewOwnerClaim", "type": "object" };
var schema131 = { "description": "Who can create an account on an instance. The same spelling as the\n`[auth] registration_mode` config value.", "enum": ["open", "invite_only"], "type": "string" };
function validate86(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate86.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.salt === void 0 && (missing0 = "salt") || data.kdf === void 0 && (missing0 = "kdf") || data.auth_key === void 0 && (missing0 = "auth_key")) {
        validate86.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.auth_key !== void 0) {
          const _errs1 = errors;
          if (typeof data.auth_key !== "string") {
            validate86.errors = [{ instancePath: instancePath + "/auth_key", schemaPath: "#/properties/auth_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.kdf !== void 0) {
            let data1 = data.kdf;
            const _errs3 = errors;
            const _errs4 = errors;
            if (errors === _errs4) {
              if (data1 && typeof data1 == "object" && !Array.isArray(data1)) {
                let missing1;
                if (data1.alg === void 0 && (missing1 = "alg") || data1.log_n === void 0 && (missing1 = "log_n") || data1.r === void 0 && (missing1 = "r") || data1.p === void 0 && (missing1 = "p")) {
                  validate86.errors = [{ instancePath: instancePath + "/kdf", schemaPath: "#/$defs/KdfParams/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                  return false;
                } else {
                  if (data1.alg !== void 0) {
                    const _errs6 = errors;
                    if (typeof data1.alg !== "string") {
                      validate86.errors = [{ instancePath: instancePath + "/kdf/alg", schemaPath: "#/$defs/KdfParams/properties/alg/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid2 = _errs6 === errors;
                  } else {
                    var valid2 = true;
                  }
                  if (valid2) {
                    if (data1.log_n !== void 0) {
                      let data3 = data1.log_n;
                      const _errs8 = errors;
                      if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3))) {
                        validate86.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      if (errors === _errs8) {
                        if (typeof data3 == "number" && isFinite(data3)) {
                          if (data3 > 255 || isNaN(data3)) {
                            validate86.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/maximum", keyword: "maximum", params: { comparison: "<=", limit: 255 }, message: "must be <= 255" }];
                            return false;
                          } else {
                            if (data3 < 0 || isNaN(data3)) {
                              validate86.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                              return false;
                            }
                          }
                        }
                      }
                      var valid2 = _errs8 === errors;
                    } else {
                      var valid2 = true;
                    }
                    if (valid2) {
                      if (data1.p !== void 0) {
                        let data4 = data1.p;
                        const _errs10 = errors;
                        if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
                          validate86.errors = [{ instancePath: instancePath + "/kdf/p", schemaPath: "#/$defs/KdfParams/properties/p/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                          return false;
                        }
                        if (errors === _errs10) {
                          if (typeof data4 == "number" && isFinite(data4)) {
                            if (data4 < 0 || isNaN(data4)) {
                              validate86.errors = [{ instancePath: instancePath + "/kdf/p", schemaPath: "#/$defs/KdfParams/properties/p/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                              return false;
                            }
                          }
                        }
                        var valid2 = _errs10 === errors;
                      } else {
                        var valid2 = true;
                      }
                      if (valid2) {
                        if (data1.r !== void 0) {
                          let data5 = data1.r;
                          const _errs12 = errors;
                          if (!(typeof data5 == "number" && (!(data5 % 1) && !isNaN(data5)) && isFinite(data5))) {
                            validate86.errors = [{ instancePath: instancePath + "/kdf/r", schemaPath: "#/$defs/KdfParams/properties/r/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                            return false;
                          }
                          if (errors === _errs12) {
                            if (typeof data5 == "number" && isFinite(data5)) {
                              if (data5 < 0 || isNaN(data5)) {
                                validate86.errors = [{ instancePath: instancePath + "/kdf/r", schemaPath: "#/$defs/KdfParams/properties/r/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                return false;
                              }
                            }
                          }
                          var valid2 = _errs12 === errors;
                        } else {
                          var valid2 = true;
                        }
                      }
                    }
                  }
                }
              } else {
                validate86.errors = [{ instancePath: instancePath + "/kdf", schemaPath: "#/$defs/KdfParams/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                return false;
              }
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.salt !== void 0) {
              const _errs14 = errors;
              if (typeof data.salt !== "string") {
                validate86.errors = [{ instancePath: instancePath + "/salt", schemaPath: "#/properties/salt/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              var valid0 = _errs14 === errors;
            } else {
              var valid0 = true;
            }
          }
        }
      }
    } else {
      validate86.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate86.errors = vErrors;
  return errors === 0;
}
validate86.evaluated = { "props": { "auth_key": true, "kdf": true, "salt": true }, "dynamicProps": false, "dynamicItems": false };
function validate88(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate88.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.public_key === void 0 && (missing0 = "public_key") || data.wrapped_key === void 0 && (missing0 = "wrapped_key") || data.wrap_alg === void 0 && (missing0 = "wrap_alg") || data.proof === void 0 && (missing0 = "proof")) {
        validate88.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.proof !== void 0) {
          let data0 = data.proof;
          const _errs1 = errors;
          const _errs2 = errors;
          if (errors === _errs2) {
            if (data0 && typeof data0 == "object" && !Array.isArray(data0)) {
              let missing1;
              if (data0.nonce === void 0 && (missing1 = "nonce") || data0.timestamp === void 0 && (missing1 = "timestamp") || data0.signature === void 0 && (missing1 = "signature")) {
                validate88.errors = [{ instancePath: instancePath + "/proof", schemaPath: "#/$defs/IdentityProof/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                return false;
              } else {
                if (data0.nonce !== void 0) {
                  const _errs4 = errors;
                  if (typeof data0.nonce !== "string") {
                    validate88.errors = [{ instancePath: instancePath + "/proof/nonce", schemaPath: "#/$defs/IdentityProof/properties/nonce/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                  var valid2 = _errs4 === errors;
                } else {
                  var valid2 = true;
                }
                if (valid2) {
                  if (data0.signature !== void 0) {
                    const _errs6 = errors;
                    if (typeof data0.signature !== "string") {
                      validate88.errors = [{ instancePath: instancePath + "/proof/signature", schemaPath: "#/$defs/IdentityProof/properties/signature/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid2 = _errs6 === errors;
                  } else {
                    var valid2 = true;
                  }
                  if (valid2) {
                    if (data0.timestamp !== void 0) {
                      let data3 = data0.timestamp;
                      const _errs8 = errors;
                      if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3))) {
                        validate88.errors = [{ instancePath: instancePath + "/proof/timestamp", schemaPath: "#/$defs/IdentityProof/properties/timestamp/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      var valid2 = _errs8 === errors;
                    } else {
                      var valid2 = true;
                    }
                  }
                }
              }
            } else {
              validate88.errors = [{ instancePath: instancePath + "/proof", schemaPath: "#/$defs/IdentityProof/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
              return false;
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.public_key !== void 0) {
            const _errs10 = errors;
            if (typeof data.public_key !== "string") {
              validate88.errors = [{ instancePath: instancePath + "/public_key", schemaPath: "#/properties/public_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs10 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.wrap_alg !== void 0) {
              const _errs12 = errors;
              if (typeof data.wrap_alg !== "string") {
                validate88.errors = [{ instancePath: instancePath + "/wrap_alg", schemaPath: "#/properties/wrap_alg/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              var valid0 = _errs12 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.wrapped_key !== void 0) {
                const _errs14 = errors;
                if (typeof data.wrapped_key !== "string") {
                  validate88.errors = [{ instancePath: instancePath + "/wrapped_key", schemaPath: "#/properties/wrapped_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
                var valid0 = _errs14 === errors;
              } else {
                var valid0 = true;
              }
            }
          }
        }
      }
    } else {
      validate88.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate88.errors = vErrors;
  return errors === 0;
}
validate88.evaluated = { "props": { "proof": true, "public_key": true, "wrap_alg": true, "wrapped_key": true }, "dynamicProps": false, "dynamicItems": false };
function validate85(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate85.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.username === void 0 && (missing0 = "username") || data.instance_name === void 0 && (missing0 = "instance_name") || data.initial_space_name === void 0 && (missing0 = "initial_space_name") || data.initial_space_hue === void 0 && (missing0 = "initial_space_hue") || data.initial_space_template === void 0 && (missing0 = "initial_space_template") || data.credential === void 0 && (missing0 = "credential") || data.identity === void 0 && (missing0 = "identity")) {
        validate85.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.credential !== void 0) {
          const _errs1 = errors;
          if (!validate86(data.credential, { instancePath: instancePath + "/credential", parentData: data, parentDataProperty: "credential", rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate86.errors : vErrors.concat(validate86.errors);
            errors = vErrors.length;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.display_name !== void 0) {
            let data1 = data.display_name;
            const _errs2 = errors;
            if (typeof data1 !== "string" && data1 !== null) {
              validate85.errors = [{ instancePath: instancePath + "/display_name", schemaPath: "#/properties/display_name/type", keyword: "type", params: { type: schema125.properties.display_name.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs2 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.email !== void 0) {
              let data2 = data.email;
              const _errs4 = errors;
              if (typeof data2 !== "string" && data2 !== null) {
                validate85.errors = [{ instancePath: instancePath + "/email", schemaPath: "#/properties/email/type", keyword: "type", params: { type: schema125.properties.email.type }, message: "must be string,null" }];
                return false;
              }
              var valid0 = _errs4 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.identity !== void 0) {
                const _errs6 = errors;
                if (!validate88(data.identity, { instancePath: instancePath + "/identity", parentData: data, parentDataProperty: "identity", rootData, dynamicAnchors })) {
                  vErrors = vErrors === null ? validate88.errors : vErrors.concat(validate88.errors);
                  errors = vErrors.length;
                }
                var valid0 = _errs6 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.initial_space_hue !== void 0) {
                  let data4 = data.initial_space_hue;
                  const _errs7 = errors;
                  if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
                    validate85.errors = [{ instancePath: instancePath + "/initial_space_hue", schemaPath: "#/properties/initial_space_hue/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                    return false;
                  }
                  if (errors === _errs7) {
                    if (typeof data4 == "number" && isFinite(data4)) {
                      if (data4 > 359 || isNaN(data4)) {
                        validate85.errors = [{ instancePath: instancePath + "/initial_space_hue", schemaPath: "#/properties/initial_space_hue/maximum", keyword: "maximum", params: { comparison: "<=", limit: 359 }, message: "must be <= 359" }];
                        return false;
                      } else {
                        if (data4 < 0 || isNaN(data4)) {
                          validate85.errors = [{ instancePath: instancePath + "/initial_space_hue", schemaPath: "#/properties/initial_space_hue/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
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
                  if (data.initial_space_icon !== void 0) {
                    let data5 = data.initial_space_icon;
                    const _errs9 = errors;
                    if (typeof data5 !== "string" && data5 !== null) {
                      validate85.errors = [{ instancePath: instancePath + "/initial_space_icon", schemaPath: "#/properties/initial_space_icon/type", keyword: "type", params: { type: schema125.properties.initial_space_icon.type }, message: "must be string,null" }];
                      return false;
                    }
                    var valid0 = _errs9 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.initial_space_name !== void 0) {
                      const _errs11 = errors;
                      if (typeof data.initial_space_name !== "string") {
                        validate85.errors = [{ instancePath: instancePath + "/initial_space_name", schemaPath: "#/properties/initial_space_name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                        return false;
                      }
                      var valid0 = _errs11 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.initial_space_template !== void 0) {
                        let data7 = data.initial_space_template;
                        const _errs13 = errors;
                        const _errs15 = errors;
                        let valid2 = false;
                        let passing0 = null;
                        const _errs16 = errors;
                        if (typeof data7 !== "string") {
                          const err0 = { instancePath: instancePath + "/initial_space_template", schemaPath: "#/$defs/InitialServerTemplate/oneOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                          if (vErrors === null) {
                            vErrors = [err0];
                          } else {
                            vErrors.push(err0);
                          }
                          errors++;
                        }
                        if ("friends" !== data7) {
                          const err1 = { instancePath: instancePath + "/initial_space_template", schemaPath: "#/$defs/InitialServerTemplate/oneOf/0/const", keyword: "const", params: { allowedValue: "friends" }, message: "must be equal to constant" };
                          if (vErrors === null) {
                            vErrors = [err1];
                          } else {
                            vErrors.push(err1);
                          }
                          errors++;
                        }
                        var _valid0 = _errs16 === errors;
                        if (_valid0) {
                          valid2 = true;
                          passing0 = 0;
                        }
                        if (!valid2) {
                          const err2 = { instancePath: instancePath + "/initial_space_template", schemaPath: "#/$defs/InitialServerTemplate/oneOf", keyword: "oneOf", params: { passingSchemas: passing0 }, message: "must match exactly one schema in oneOf" };
                          if (vErrors === null) {
                            vErrors = [err2];
                          } else {
                            vErrors.push(err2);
                          }
                          errors++;
                          validate85.errors = vErrors;
                          return false;
                        } else {
                          errors = _errs15;
                          if (vErrors !== null) {
                            if (_errs15) {
                              vErrors.length = _errs15;
                            } else {
                              vErrors = null;
                            }
                          }
                        }
                        var valid0 = _errs13 === errors;
                      } else {
                        var valid0 = true;
                      }
                      if (valid0) {
                        if (data.instance_name !== void 0) {
                          const _errs18 = errors;
                          if (typeof data.instance_name !== "string") {
                            validate85.errors = [{ instancePath: instancePath + "/instance_name", schemaPath: "#/properties/instance_name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                            return false;
                          }
                          var valid0 = _errs18 === errors;
                        } else {
                          var valid0 = true;
                        }
                        if (valid0) {
                          if (data.registration_mode !== void 0) {
                            let data9 = data.registration_mode;
                            const _errs20 = errors;
                            const _errs21 = errors;
                            let valid3 = false;
                            const _errs22 = errors;
                            if (typeof data9 !== "string") {
                              const err3 = { instancePath: instancePath + "/registration_mode", schemaPath: "#/$defs/RegistrationMode/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                              if (vErrors === null) {
                                vErrors = [err3];
                              } else {
                                vErrors.push(err3);
                              }
                              errors++;
                            }
                            if (!(data9 === "open" || data9 === "invite_only")) {
                              const err4 = { instancePath: instancePath + "/registration_mode", schemaPath: "#/$defs/RegistrationMode/enum", keyword: "enum", params: { allowedValues: schema131.enum }, message: "must be equal to one of the allowed values" };
                              if (vErrors === null) {
                                vErrors = [err4];
                              } else {
                                vErrors.push(err4);
                              }
                              errors++;
                            }
                            var _valid1 = _errs22 === errors;
                            valid3 = valid3 || _valid1;
                            const _errs25 = errors;
                            if (data9 !== null) {
                              const err5 = { instancePath: instancePath + "/registration_mode", schemaPath: "#/properties/registration_mode/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                              if (vErrors === null) {
                                vErrors = [err5];
                              } else {
                                vErrors.push(err5);
                              }
                              errors++;
                            }
                            var _valid1 = _errs25 === errors;
                            valid3 = valid3 || _valid1;
                            if (!valid3) {
                              const err6 = { instancePath: instancePath + "/registration_mode", schemaPath: "#/properties/registration_mode/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                              if (vErrors === null) {
                                vErrors = [err6];
                              } else {
                                vErrors.push(err6);
                              }
                              errors++;
                              validate85.errors = vErrors;
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
                            if (data.username !== void 0) {
                              const _errs27 = errors;
                              if (typeof data.username !== "string") {
                                validate85.errors = [{ instancePath: instancePath + "/username", schemaPath: "#/properties/username/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                return false;
                              }
                              var valid0 = _errs27 === errors;
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
    } else {
      validate85.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate85.errors = vErrors;
  return errors === 0;
}
validate85.evaluated = { "props": { "credential": true, "display_name": true, "email": true, "identity": true, "initial_space_hue": true, "initial_space_icon": true, "initial_space_name": true, "initial_space_template": true, "instance_name": true, "registration_mode": true, "username": true }, "dynamicProps": false, "dynamicItems": false };
var isOwnershipTransferResponse = validate90;
function validate90(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate90.evaluated;
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
        validate90.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.id !== void 0) {
          const _errs1 = errors;
          if (typeof data.id !== "string") {
            validate90.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
              validate90.errors = [{ instancePath: instancePath + "/owner_id", schemaPath: "#/properties/owner_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
        }
      }
    } else {
      validate90.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate90.errors = vErrors;
  return errors === 0;
}
validate90.evaluated = { "props": { "id": true, "owner_id": true }, "dynamicProps": false, "dynamicItems": false };
var isPasswordRequirements = validate91;
function validate91(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate91.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.min_length === void 0 && (missing0 = "min_length") || data.max_length === void 0 && (missing0 = "max_length") || data.requires_uppercase === void 0 && (missing0 = "requires_uppercase") || data.requires_lowercase === void 0 && (missing0 = "requires_lowercase") || data.requires_digit === void 0 && (missing0 = "requires_digit") || data.requires_symbol === void 0 && (missing0 = "requires_symbol") || data.length_unit === void 0 && (missing0 = "length_unit")) {
        validate91.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.enforced_by !== void 0) {
          let data0 = data.enforced_by;
          const _errs1 = errors;
          const _errs3 = errors;
          let valid2 = false;
          let passing0 = null;
          const _errs4 = errors;
          if (typeof data0 !== "string") {
            const err0 = { instancePath: instancePath + "/enforced_by", schemaPath: "#/$defs/PasswordRulesEnforcedBy/oneOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err0];
            } else {
              vErrors.push(err0);
            }
            errors++;
          }
          if ("client" !== data0) {
            const err1 = { instancePath: instancePath + "/enforced_by", schemaPath: "#/$defs/PasswordRulesEnforcedBy/oneOf/0/const", keyword: "const", params: { allowedValue: "client" }, message: "must be equal to constant" };
            if (vErrors === null) {
              vErrors = [err1];
            } else {
              vErrors.push(err1);
            }
            errors++;
          }
          var _valid0 = _errs4 === errors;
          if (_valid0) {
            valid2 = true;
            passing0 = 0;
          }
          const _errs6 = errors;
          if (typeof data0 !== "string") {
            const err2 = { instancePath: instancePath + "/enforced_by", schemaPath: "#/$defs/PasswordRulesEnforcedBy/oneOf/1/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err2];
            } else {
              vErrors.push(err2);
            }
            errors++;
          }
          if ("server" !== data0) {
            const err3 = { instancePath: instancePath + "/enforced_by", schemaPath: "#/$defs/PasswordRulesEnforcedBy/oneOf/1/const", keyword: "const", params: { allowedValue: "server" }, message: "must be equal to constant" };
            if (vErrors === null) {
              vErrors = [err3];
            } else {
              vErrors.push(err3);
            }
            errors++;
          }
          var _valid0 = _errs6 === errors;
          if (_valid0 && valid2) {
            valid2 = false;
            passing0 = [passing0, 1];
          } else {
            if (_valid0) {
              valid2 = true;
              passing0 = 1;
            }
          }
          if (!valid2) {
            const err4 = { instancePath: instancePath + "/enforced_by", schemaPath: "#/$defs/PasswordRulesEnforcedBy/oneOf", keyword: "oneOf", params: { passingSchemas: passing0 }, message: "must match exactly one schema in oneOf" };
            if (vErrors === null) {
              vErrors = [err4];
            } else {
              vErrors.push(err4);
            }
            errors++;
            validate91.errors = vErrors;
            return false;
          } else {
            errors = _errs3;
            if (vErrors !== null) {
              if (_errs3) {
                vErrors.length = _errs3;
              } else {
                vErrors = null;
              }
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.length_unit !== void 0) {
            const _errs8 = errors;
            if (typeof data.length_unit !== "string") {
              validate91.errors = [{ instancePath: instancePath + "/length_unit", schemaPath: "#/properties/length_unit/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            var valid0 = _errs8 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.max_length !== void 0) {
              let data2 = data.max_length;
              const _errs10 = errors;
              if (!(typeof data2 == "number" && (!(data2 % 1) && !isNaN(data2)) && isFinite(data2))) {
                validate91.errors = [{ instancePath: instancePath + "/max_length", schemaPath: "#/properties/max_length/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                return false;
              }
              if (errors === _errs10) {
                if (typeof data2 == "number" && isFinite(data2)) {
                  if (data2 > 4294967295 || isNaN(data2)) {
                    validate91.errors = [{ instancePath: instancePath + "/max_length", schemaPath: "#/properties/max_length/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" }];
                    return false;
                  } else {
                    if (data2 < 0 || isNaN(data2)) {
                      validate91.errors = [{ instancePath: instancePath + "/max_length", schemaPath: "#/properties/max_length/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                      return false;
                    }
                  }
                }
              }
              var valid0 = _errs10 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.min_length !== void 0) {
                let data3 = data.min_length;
                const _errs12 = errors;
                if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3))) {
                  validate91.errors = [{ instancePath: instancePath + "/min_length", schemaPath: "#/properties/min_length/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                  return false;
                }
                if (errors === _errs12) {
                  if (typeof data3 == "number" && isFinite(data3)) {
                    if (data3 > 4294967295 || isNaN(data3)) {
                      validate91.errors = [{ instancePath: instancePath + "/min_length", schemaPath: "#/properties/min_length/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" }];
                      return false;
                    } else {
                      if (data3 < 0 || isNaN(data3)) {
                        validate91.errors = [{ instancePath: instancePath + "/min_length", schemaPath: "#/properties/min_length/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                        return false;
                      }
                    }
                  }
                }
                var valid0 = _errs12 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.requires_digit !== void 0) {
                  const _errs14 = errors;
                  if (typeof data.requires_digit !== "boolean") {
                    validate91.errors = [{ instancePath: instancePath + "/requires_digit", schemaPath: "#/properties/requires_digit/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                    return false;
                  }
                  var valid0 = _errs14 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.requires_lowercase !== void 0) {
                    const _errs16 = errors;
                    if (typeof data.requires_lowercase !== "boolean") {
                      validate91.errors = [{ instancePath: instancePath + "/requires_lowercase", schemaPath: "#/properties/requires_lowercase/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                      return false;
                    }
                    var valid0 = _errs16 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.requires_symbol !== void 0) {
                      const _errs18 = errors;
                      if (typeof data.requires_symbol !== "boolean") {
                        validate91.errors = [{ instancePath: instancePath + "/requires_symbol", schemaPath: "#/properties/requires_symbol/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                        return false;
                      }
                      var valid0 = _errs18 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.requires_uppercase !== void 0) {
                        const _errs20 = errors;
                        if (typeof data.requires_uppercase !== "boolean") {
                          validate91.errors = [{ instancePath: instancePath + "/requires_uppercase", schemaPath: "#/properties/requires_uppercase/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                          return false;
                        }
                        var valid0 = _errs20 === errors;
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
      validate91.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate91.errors = vErrors;
  return errors === 0;
}
validate91.evaluated = { "props": { "enforced_by": true, "length_unit": true, "max_length": true, "min_length": true, "requires_digit": true, "requires_lowercase": true, "requires_symbol": true, "requires_uppercase": true }, "dynamicProps": false, "dynamicItems": false };
var isPublicUserProfile = validate92;
var schema136 = { "description": "A friend shared by the viewer and the profile subject.", "properties": { "avatar_hash": { "type": ["string", "null"] }, "discriminator": { "format": "int32", "type": "integer" }, "id": { "type": "string" }, "username": { "type": "string" } }, "required": ["id", "username", "discriminator", "avatar_hash"], "type": "object" };
var schema137 = { "description": "A guild shared by the viewer and the profile subject. `icon_url` is the\npersisted icon hash; the wire name predates the `icon_hash` convention.", "properties": { "icon_url": { "type": ["string", "null"] }, "id": { "type": "string" }, "name": { "type": "string" } }, "required": ["id", "name", "icon_url"], "type": "object" };
var schema139 = { "description": "The user object embedded in the public profile response.", "properties": { "accent_color": { "description": "Profile accent as `0xRRGGBB`. Omitted when the member has not chosen one.\n\nNew in 3.2. Unlike the other nullable fields it may be absent rather\nthan null, so a 3.2 client can still read accounts from a 3.1 instance,\nwhich never sends it.", "format": "int32", "type": ["integer", "null"] }, "avatar_hash": { "type": ["string", "null"] }, "banner_hash": { "type": ["string", "null"] }, "bio": { "type": ["string", "null"] }, "bot": { "type": "boolean" }, "created_at": { "type": "string" }, "discriminator": { "format": "int32", "type": "integer" }, "display_name": { "type": ["string", "null"] }, "flags": { "format": "int32", "type": "integer" }, "id": { "type": "string" }, "linked_accounts": { "items": { "$ref": "#/$defs/LinkedAccount" }, "type": "array" }, "pronouns": { "type": ["string", "null"] }, "system": { "type": "boolean" }, "username": { "type": "string" } }, "required": ["id", "username", "discriminator", "display_name", "avatar_hash", "banner_hash", "bio", "flags", "bot", "system", "created_at", "pronouns", "linked_accounts"], "type": "object" };
function validate93(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate93.evaluated;
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
        validate93.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.accent_color !== void 0) {
          let data0 = data.accent_color;
          const _errs1 = errors;
          if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)) && isFinite(data0)) && data0 !== null) {
            validate93.errors = [{ instancePath: instancePath + "/accent_color", schemaPath: "#/properties/accent_color/type", keyword: "type", params: { type: schema139.properties.accent_color.type }, message: "must be integer,null" }];
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
              validate93.errors = [{ instancePath: instancePath + "/avatar_hash", schemaPath: "#/properties/avatar_hash/type", keyword: "type", params: { type: schema139.properties.avatar_hash.type }, message: "must be string,null" }];
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
                validate93.errors = [{ instancePath: instancePath + "/banner_hash", schemaPath: "#/properties/banner_hash/type", keyword: "type", params: { type: schema139.properties.banner_hash.type }, message: "must be string,null" }];
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
                  validate93.errors = [{ instancePath: instancePath + "/bio", schemaPath: "#/properties/bio/type", keyword: "type", params: { type: schema139.properties.bio.type }, message: "must be string,null" }];
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
                    validate93.errors = [{ instancePath: instancePath + "/bot", schemaPath: "#/properties/bot/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
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
                      validate93.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                        validate93.errors = [{ instancePath: instancePath + "/discriminator", schemaPath: "#/properties/discriminator/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
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
                          validate93.errors = [{ instancePath: instancePath + "/display_name", schemaPath: "#/properties/display_name/type", keyword: "type", params: { type: schema139.properties.display_name.type }, message: "must be string,null" }];
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
                            validate93.errors = [{ instancePath: instancePath + "/flags", schemaPath: "#/properties/flags/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
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
                              validate93.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                          validate93.errors = [{ instancePath: instancePath + "/linked_accounts/" + i0, schemaPath: "#/$defs/LinkedAccount/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                                          return false;
                                        } else {
                                          if (data11.label !== void 0) {
                                            const _errs26 = errors;
                                            if (typeof data11.label !== "string") {
                                              validate93.errors = [{ instancePath: instancePath + "/linked_accounts/" + i0 + "/label", schemaPath: "#/$defs/LinkedAccount/properties/label/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                                validate93.errors = [{ instancePath: instancePath + "/linked_accounts/" + i0 + "/url", schemaPath: "#/$defs/LinkedAccount/properties/url/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                                return false;
                                              }
                                              var valid3 = _errs28 === errors;
                                            } else {
                                              var valid3 = true;
                                            }
                                          }
                                        }
                                      } else {
                                        validate93.errors = [{ instancePath: instancePath + "/linked_accounts/" + i0, schemaPath: "#/$defs/LinkedAccount/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                                        return false;
                                      }
                                    }
                                    var valid1 = _errs23 === errors;
                                    if (!valid1) {
                                      break;
                                    }
                                  }
                                } else {
                                  validate93.errors = [{ instancePath: instancePath + "/linked_accounts", schemaPath: "#/properties/linked_accounts/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
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
                                  validate93.errors = [{ instancePath: instancePath + "/pronouns", schemaPath: "#/properties/pronouns/type", keyword: "type", params: { type: schema139.properties.pronouns.type }, message: "must be string,null" }];
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
                                    validate93.errors = [{ instancePath: instancePath + "/system", schemaPath: "#/properties/system/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
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
                                      validate93.errors = [{ instancePath: instancePath + "/username", schemaPath: "#/properties/username/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
      validate93.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate93.errors = vErrors;
  return errors === 0;
}
validate93.evaluated = { "props": { "accent_color": true, "avatar_hash": true, "banner_hash": true, "bio": true, "bot": true, "created_at": true, "discriminator": true, "display_name": true, "flags": true, "id": true, "linked_accounts": true, "pronouns": true, "system": true, "username": true }, "dynamicProps": false, "dynamicItems": false };
function validate92(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate92.evaluated;
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
        validate92.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.created_at !== void 0) {
          const _errs1 = errors;
          if (typeof data.created_at !== "string") {
            validate92.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                        validate92.errors = [{ instancePath: instancePath + "/mutual_friends/" + i0, schemaPath: "#/$defs/MutualFriend/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                        return false;
                      } else {
                        if (data2.avatar_hash !== void 0) {
                          let data3 = data2.avatar_hash;
                          const _errs8 = errors;
                          if (typeof data3 !== "string" && data3 !== null) {
                            validate92.errors = [{ instancePath: instancePath + "/mutual_friends/" + i0 + "/avatar_hash", schemaPath: "#/$defs/MutualFriend/properties/avatar_hash/type", keyword: "type", params: { type: schema136.properties.avatar_hash.type }, message: "must be string,null" }];
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
                              validate92.errors = [{ instancePath: instancePath + "/mutual_friends/" + i0 + "/discriminator", schemaPath: "#/$defs/MutualFriend/properties/discriminator/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
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
                                validate92.errors = [{ instancePath: instancePath + "/mutual_friends/" + i0 + "/id", schemaPath: "#/$defs/MutualFriend/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                  validate92.errors = [{ instancePath: instancePath + "/mutual_friends/" + i0 + "/username", schemaPath: "#/$defs/MutualFriend/properties/username/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                      validate92.errors = [{ instancePath: instancePath + "/mutual_friends/" + i0, schemaPath: "#/$defs/MutualFriend/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                      return false;
                    }
                  }
                  var valid1 = _errs5 === errors;
                  if (!valid1) {
                    break;
                  }
                }
              } else {
                validate92.errors = [{ instancePath: instancePath + "/mutual_friends", schemaPath: "#/properties/mutual_friends/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
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
                          validate92.errors = [{ instancePath: instancePath + "/mutual_guilds/" + i1, schemaPath: "#/$defs/MutualGuild/required", keyword: "required", params: { missingProperty: missing2 }, message: "must have required property '" + missing2 + "'" }];
                          return false;
                        } else {
                          if (data8.icon_url !== void 0) {
                            let data9 = data8.icon_url;
                            const _errs21 = errors;
                            if (typeof data9 !== "string" && data9 !== null) {
                              validate92.errors = [{ instancePath: instancePath + "/mutual_guilds/" + i1 + "/icon_url", schemaPath: "#/$defs/MutualGuild/properties/icon_url/type", keyword: "type", params: { type: schema137.properties.icon_url.type }, message: "must be string,null" }];
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
                                validate92.errors = [{ instancePath: instancePath + "/mutual_guilds/" + i1 + "/id", schemaPath: "#/$defs/MutualGuild/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                  validate92.errors = [{ instancePath: instancePath + "/mutual_guilds/" + i1 + "/name", schemaPath: "#/$defs/MutualGuild/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                        validate92.errors = [{ instancePath: instancePath + "/mutual_guilds/" + i1, schemaPath: "#/$defs/MutualGuild/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                        return false;
                      }
                    }
                    var valid4 = _errs18 === errors;
                    if (!valid4) {
                      break;
                    }
                  }
                } else {
                  validate92.errors = [{ instancePath: instancePath + "/mutual_guilds", schemaPath: "#/properties/mutual_guilds/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
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
                            validate92.errors = [{ instancePath: instancePath + "/roles/" + i2, schemaPath: "#/$defs/ProfileRole/required", keyword: "required", params: { missingProperty: missing3 }, message: "must have required property '" + missing3 + "'" }];
                            return false;
                          } else {
                            if (data13.color !== void 0) {
                              let data14 = data13.color;
                              const _errs32 = errors;
                              if (!(typeof data14 == "number" && (!(data14 % 1) && !isNaN(data14)) && isFinite(data14))) {
                                validate92.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/color", schemaPath: "#/$defs/ProfileRole/properties/color/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
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
                                  validate92.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/created_at", schemaPath: "#/$defs/ProfileRole/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                    validate92.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/guild_id", schemaPath: "#/$defs/ProfileRole/properties/guild_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                      validate92.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/hoist", schemaPath: "#/$defs/ProfileRole/properties/hoist/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
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
                                        validate92.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/id", schemaPath: "#/$defs/ProfileRole/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                          validate92.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/mentionable", schemaPath: "#/$defs/ProfileRole/properties/mentionable/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
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
                                            validate92.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/name", schemaPath: "#/$defs/ProfileRole/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                              validate92.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/permissions", schemaPath: "#/$defs/ProfileRole/properties/permissions/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                                validate92.errors = [{ instancePath: instancePath + "/roles/" + i2 + "/position", schemaPath: "#/$defs/ProfileRole/properties/position/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
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
                          validate92.errors = [{ instancePath: instancePath + "/roles/" + i2, schemaPath: "#/$defs/ProfileRole/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                          return false;
                        }
                      }
                      var valid7 = _errs29 === errors;
                      if (!valid7) {
                        break;
                      }
                    }
                  } else {
                    validate92.errors = [{ instancePath: instancePath + "/roles", schemaPath: "#/properties/roles/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
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
                  if (!validate93(data.user, { instancePath: instancePath + "/user", parentData: data, parentDataProperty: "user", rootData, dynamicAnchors })) {
                    vErrors = vErrors === null ? validate93.errors : vErrors.concat(validate93.errors);
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
      validate92.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate92.errors = vErrors;
  return errors === 0;
}
validate92.evaluated = { "props": { "created_at": true, "mutual_friends": true, "mutual_guilds": true, "roles": true, "user": true }, "dynamicProps": false, "dynamicItems": false };
var isReadyGuildCore = validate95;
var schema141 = { "$id": "urn:paracord:contract:ReadyGuildCore", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "Persisted space metadata carried by the gateway READY payload.\nDistinct from `GuildSummary`: READY sends only durable fields, never the\nREST settings surface. Nullable fields are present, including when null.", "properties": { "created_at": { "minLength": 1, "type": "string" }, "hue": { "default": null, "description": "The server's color as a hue, 0-359; null when unset. Always sent;\noptional only so a client accepts an older server that has no colors\n(see `GuildSummary::hue`).", "format": "uint32", "maximum": 359, "minimum": 0, "type": ["integer", "null"] }, "icon_hash": { "type": ["string", "null"] }, "id": { "minLength": 1, "pattern": "\\S", "type": "string" }, "member_count": { "format": "uint32", "maximum": 4294967295, "minimum": 0, "type": "integer" }, "name": { "minLength": 1, "pattern": "\\S", "type": "string" }, "owner_id": { "minLength": 1, "pattern": "\\S", "type": "string" } }, "required": ["id", "owner_id", "name", "icon_hash", "created_at", "member_count"], "title": "ReadyGuildCore", "type": "object" };
var pattern10 = new RegExp("\\S", "u");
function validate95(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate95.evaluated;
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
        validate95.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.created_at !== void 0) {
          let data0 = data.created_at;
          const _errs1 = errors;
          if (errors === _errs1) {
            if (typeof data0 === "string") {
              if (func1(data0) < 1) {
                validate95.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                return false;
              }
            } else {
              validate95.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.hue !== void 0) {
            let data1 = data.hue;
            const _errs3 = errors;
            if (!(typeof data1 == "number" && (!(data1 % 1) && !isNaN(data1)) && isFinite(data1)) && data1 !== null) {
              validate95.errors = [{ instancePath: instancePath + "/hue", schemaPath: "#/properties/hue/type", keyword: "type", params: { type: schema141.properties.hue.type }, message: "must be integer,null" }];
              return false;
            }
            if (errors === _errs3) {
              if (typeof data1 == "number" && isFinite(data1)) {
                if (data1 > 359 || isNaN(data1)) {
                  validate95.errors = [{ instancePath: instancePath + "/hue", schemaPath: "#/properties/hue/maximum", keyword: "maximum", params: { comparison: "<=", limit: 359 }, message: "must be <= 359" }];
                  return false;
                } else {
                  if (data1 < 0 || isNaN(data1)) {
                    validate95.errors = [{ instancePath: instancePath + "/hue", schemaPath: "#/properties/hue/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                    return false;
                  }
                }
              }
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.icon_hash !== void 0) {
              let data2 = data.icon_hash;
              const _errs5 = errors;
              if (typeof data2 !== "string" && data2 !== null) {
                validate95.errors = [{ instancePath: instancePath + "/icon_hash", schemaPath: "#/properties/icon_hash/type", keyword: "type", params: { type: schema141.properties.icon_hash.type }, message: "must be string,null" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.id !== void 0) {
                let data3 = data.id;
                const _errs7 = errors;
                if (errors === _errs7) {
                  if (typeof data3 === "string") {
                    if (func1(data3) < 1) {
                      validate95.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                      return false;
                    } else {
                      if (!pattern10.test(data3)) {
                        validate95.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/pattern", keyword: "pattern", params: { pattern: "\\S" }, message: 'must match pattern "\\S"' }];
                        return false;
                      }
                    }
                  } else {
                    validate95.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                }
                var valid0 = _errs7 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.member_count !== void 0) {
                  let data4 = data.member_count;
                  const _errs9 = errors;
                  if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
                    validate95.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                    return false;
                  }
                  if (errors === _errs9) {
                    if (typeof data4 == "number" && isFinite(data4)) {
                      if (data4 > 4294967295 || isNaN(data4)) {
                        validate95.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" }];
                        return false;
                      } else {
                        if (data4 < 0 || isNaN(data4)) {
                          validate95.errors = [{ instancePath: instancePath + "/member_count", schemaPath: "#/properties/member_count/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                          return false;
                        }
                      }
                    }
                  }
                  var valid0 = _errs9 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.name !== void 0) {
                    let data5 = data.name;
                    const _errs11 = errors;
                    if (errors === _errs11) {
                      if (typeof data5 === "string") {
                        if (func1(data5) < 1) {
                          validate95.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                          return false;
                        } else {
                          if (!pattern10.test(data5)) {
                            validate95.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/pattern", keyword: "pattern", params: { pattern: "\\S" }, message: 'must match pattern "\\S"' }];
                            return false;
                          }
                        }
                      } else {
                        validate95.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                        return false;
                      }
                    }
                    var valid0 = _errs11 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.owner_id !== void 0) {
                      let data6 = data.owner_id;
                      const _errs13 = errors;
                      if (errors === _errs13) {
                        if (typeof data6 === "string") {
                          if (func1(data6) < 1) {
                            validate95.errors = [{ instancePath: instancePath + "/owner_id", schemaPath: "#/properties/owner_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                            return false;
                          } else {
                            if (!pattern10.test(data6)) {
                              validate95.errors = [{ instancePath: instancePath + "/owner_id", schemaPath: "#/properties/owner_id/pattern", keyword: "pattern", params: { pattern: "\\S" }, message: 'must match pattern "\\S"' }];
                              return false;
                            }
                          }
                        } else {
                          validate95.errors = [{ instancePath: instancePath + "/owner_id", schemaPath: "#/properties/owner_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                          return false;
                        }
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
      }
    } else {
      validate95.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate95.errors = vErrors;
  return errors === 0;
}
validate95.evaluated = { "props": { "created_at": true, "hue": true, "icon_hash": true, "id": true, "member_count": true, "name": true, "owner_id": true }, "dynamicProps": false, "dynamicItems": false };
var isRelationshipList = validate96;
var schema144 = { "description": "The other party's identity embedded in a relationship entry.\nNullable fields are present in responses, including when their value is null.", "properties": { "avatar_hash": { "type": ["string", "null"] }, "discriminator": { "format": "int32", "type": "integer" }, "display_name": { "type": ["string", "null"] }, "id": { "type": "string" }, "username": { "type": "string" } }, "required": ["id", "username", "display_name", "discriminator", "avatar_hash"], "type": "object" };
function validate97(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate97.evaluated;
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
        validate97.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.created_at !== void 0) {
          const _errs1 = errors;
          if (typeof data.created_at !== "string") {
            validate97.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
              validate97.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                validate97.errors = [{ instancePath: instancePath + "/rel_type", schemaPath: "#/properties/rel_type/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
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
                  validate97.errors = [{ instancePath: instancePath + "/target_id", schemaPath: "#/properties/target_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                    validate97.errors = [{ instancePath: instancePath + "/type", schemaPath: "#/properties/type/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
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
                          validate97.errors = [{ instancePath: instancePath + "/user", schemaPath: "#/$defs/RelationshipUser/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                          return false;
                        } else {
                          if (data5.avatar_hash !== void 0) {
                            let data6 = data5.avatar_hash;
                            const _errs14 = errors;
                            if (typeof data6 !== "string" && data6 !== null) {
                              validate97.errors = [{ instancePath: instancePath + "/user/avatar_hash", schemaPath: "#/$defs/RelationshipUser/properties/avatar_hash/type", keyword: "type", params: { type: schema144.properties.avatar_hash.type }, message: "must be string,null" }];
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
                                validate97.errors = [{ instancePath: instancePath + "/user/discriminator", schemaPath: "#/$defs/RelationshipUser/properties/discriminator/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
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
                                  validate97.errors = [{ instancePath: instancePath + "/user/display_name", schemaPath: "#/$defs/RelationshipUser/properties/display_name/type", keyword: "type", params: { type: schema144.properties.display_name.type }, message: "must be string,null" }];
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
                                    validate97.errors = [{ instancePath: instancePath + "/user/id", schemaPath: "#/$defs/RelationshipUser/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                      validate97.errors = [{ instancePath: instancePath + "/user/username", schemaPath: "#/$defs/RelationshipUser/properties/username/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                        validate97.errors = [{ instancePath: instancePath + "/user", schemaPath: "#/$defs/RelationshipUser/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
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
                        validate97.errors = [{ instancePath: instancePath + "/user_id", schemaPath: "#/properties/user_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
      validate97.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate97.errors = vErrors;
  return errors === 0;
}
validate97.evaluated = { "props": { "created_at": true, "id": true, "rel_type": true, "target_id": true, "type": true, "user": true, "user_id": true }, "dynamicProps": false, "dynamicItems": false };
function validate96(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate96.evaluated;
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
        if (!validate97(data[i0], { instancePath: instancePath + "/" + i0, parentData: data, parentDataProperty: i0, rootData, dynamicAnchors })) {
          vErrors = vErrors === null ? validate97.errors : vErrors.concat(validate97.errors);
          errors = vErrors.length;
        }
        var valid0 = _errs1 === errors;
        if (!valid0) {
          break;
        }
      }
    } else {
      validate96.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
      return false;
    }
  }
  validate96.errors = vErrors;
  return errors === 0;
}
validate96.evaluated = { "items": true, "dynamicProps": false, "dynamicItems": false };
var isResetCredentialRequest = validate99;
var schema145 = { "$defs": { "IdentityProof": { "description": "A signature over a server challenge, proving possession of the identity key.", "properties": { "nonce": { "description": "The nonce `/auth/challenge` issued.", "type": "string" }, "signature": { "description": 'hex Ed25519 signature over\n`"<purpose>:" + nonce + ":" + timestamp + ":" + origin`, where purpose is\n`paracord/credential/v2/register` or `paracord/credential/v2/reset`.', "type": "string" }, "timestamp": { "description": "The timestamp `/auth/challenge` issued (Unix seconds).", "format": "int64", "type": "integer" } }, "required": ["nonce", "timestamp", "signature"], "type": "object" }, "KdfParams": { "description": 'scrypt parameters as sent on the wire. Stored per credential as\n`"scrypt:<log_n>:<r>:<p>"` (see [`KdfParams::to_db_text`]).', "properties": { "alg": { "description": 'Always `"scrypt"`.', "type": "string" }, "log_n": { "description": "log2 of scrypt's N.", "format": "uint8", "maximum": 255, "minimum": 0, "type": "integer" }, "p": { "format": "uint32", "minimum": 0, "type": "integer" }, "r": { "format": "uint32", "minimum": 0, "type": "integer" } }, "required": ["alg", "log_n", "r", "p"], "type": "object" }, "NewCredential": { "description": "A freshly derived credential: what the server stores in place of a password.", "properties": { "auth_key": { "description": "b64url of the 32-byte HKDF output `paracord/credential/v2/auth`.", "type": "string" }, "kdf": { "$ref": "#/$defs/KdfParams" }, "salt": { "description": "b64url of 32 random bytes.", "type": "string" } }, "required": ["salt", "kdf", "auth_key"], "type": "object" } }, "$id": "urn:paracord:contract:ResetCredentialRequest", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "`POST /api/v1/users/@me/credential/reset`: a new password after signing in\nwith the recovery phrase (spec \xA73.8). `proof` signs a fresh challenge with\npurpose `paracord/credential/v2/reset`.", "properties": { "credential": { "$ref": "#/$defs/NewCredential" }, "mfa_code": { "default": null, "type": ["string", "null"] }, "proof": { "$ref": "#/$defs/IdentityProof" }, "wrapped_key": { "type": "string" } }, "required": ["credential", "wrapped_key", "proof"], "title": "ResetCredentialRequest", "type": "object" };
function validate100(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate100.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.salt === void 0 && (missing0 = "salt") || data.kdf === void 0 && (missing0 = "kdf") || data.auth_key === void 0 && (missing0 = "auth_key")) {
        validate100.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.auth_key !== void 0) {
          const _errs1 = errors;
          if (typeof data.auth_key !== "string") {
            validate100.errors = [{ instancePath: instancePath + "/auth_key", schemaPath: "#/properties/auth_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.kdf !== void 0) {
            let data1 = data.kdf;
            const _errs3 = errors;
            const _errs4 = errors;
            if (errors === _errs4) {
              if (data1 && typeof data1 == "object" && !Array.isArray(data1)) {
                let missing1;
                if (data1.alg === void 0 && (missing1 = "alg") || data1.log_n === void 0 && (missing1 = "log_n") || data1.r === void 0 && (missing1 = "r") || data1.p === void 0 && (missing1 = "p")) {
                  validate100.errors = [{ instancePath: instancePath + "/kdf", schemaPath: "#/$defs/KdfParams/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                  return false;
                } else {
                  if (data1.alg !== void 0) {
                    const _errs6 = errors;
                    if (typeof data1.alg !== "string") {
                      validate100.errors = [{ instancePath: instancePath + "/kdf/alg", schemaPath: "#/$defs/KdfParams/properties/alg/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    var valid2 = _errs6 === errors;
                  } else {
                    var valid2 = true;
                  }
                  if (valid2) {
                    if (data1.log_n !== void 0) {
                      let data3 = data1.log_n;
                      const _errs8 = errors;
                      if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)) && isFinite(data3))) {
                        validate100.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                        return false;
                      }
                      if (errors === _errs8) {
                        if (typeof data3 == "number" && isFinite(data3)) {
                          if (data3 > 255 || isNaN(data3)) {
                            validate100.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/maximum", keyword: "maximum", params: { comparison: "<=", limit: 255 }, message: "must be <= 255" }];
                            return false;
                          } else {
                            if (data3 < 0 || isNaN(data3)) {
                              validate100.errors = [{ instancePath: instancePath + "/kdf/log_n", schemaPath: "#/$defs/KdfParams/properties/log_n/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                              return false;
                            }
                          }
                        }
                      }
                      var valid2 = _errs8 === errors;
                    } else {
                      var valid2 = true;
                    }
                    if (valid2) {
                      if (data1.p !== void 0) {
                        let data4 = data1.p;
                        const _errs10 = errors;
                        if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
                          validate100.errors = [{ instancePath: instancePath + "/kdf/p", schemaPath: "#/$defs/KdfParams/properties/p/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                          return false;
                        }
                        if (errors === _errs10) {
                          if (typeof data4 == "number" && isFinite(data4)) {
                            if (data4 < 0 || isNaN(data4)) {
                              validate100.errors = [{ instancePath: instancePath + "/kdf/p", schemaPath: "#/$defs/KdfParams/properties/p/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                              return false;
                            }
                          }
                        }
                        var valid2 = _errs10 === errors;
                      } else {
                        var valid2 = true;
                      }
                      if (valid2) {
                        if (data1.r !== void 0) {
                          let data5 = data1.r;
                          const _errs12 = errors;
                          if (!(typeof data5 == "number" && (!(data5 % 1) && !isNaN(data5)) && isFinite(data5))) {
                            validate100.errors = [{ instancePath: instancePath + "/kdf/r", schemaPath: "#/$defs/KdfParams/properties/r/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                            return false;
                          }
                          if (errors === _errs12) {
                            if (typeof data5 == "number" && isFinite(data5)) {
                              if (data5 < 0 || isNaN(data5)) {
                                validate100.errors = [{ instancePath: instancePath + "/kdf/r", schemaPath: "#/$defs/KdfParams/properties/r/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                                return false;
                              }
                            }
                          }
                          var valid2 = _errs12 === errors;
                        } else {
                          var valid2 = true;
                        }
                      }
                    }
                  }
                }
              } else {
                validate100.errors = [{ instancePath: instancePath + "/kdf", schemaPath: "#/$defs/KdfParams/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                return false;
              }
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.salt !== void 0) {
              const _errs14 = errors;
              if (typeof data.salt !== "string") {
                validate100.errors = [{ instancePath: instancePath + "/salt", schemaPath: "#/properties/salt/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              var valid0 = _errs14 === errors;
            } else {
              var valid0 = true;
            }
          }
        }
      }
    } else {
      validate100.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate100.errors = vErrors;
  return errors === 0;
}
validate100.evaluated = { "props": { "auth_key": true, "kdf": true, "salt": true }, "dynamicProps": false, "dynamicItems": false };
function validate99(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate99.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.credential === void 0 && (missing0 = "credential") || data.wrapped_key === void 0 && (missing0 = "wrapped_key") || data.proof === void 0 && (missing0 = "proof")) {
        validate99.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.credential !== void 0) {
          const _errs1 = errors;
          if (!validate100(data.credential, { instancePath: instancePath + "/credential", parentData: data, parentDataProperty: "credential", rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate100.errors : vErrors.concat(validate100.errors);
            errors = vErrors.length;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.mfa_code !== void 0) {
            let data1 = data.mfa_code;
            const _errs2 = errors;
            if (typeof data1 !== "string" && data1 !== null) {
              validate99.errors = [{ instancePath: instancePath + "/mfa_code", schemaPath: "#/properties/mfa_code/type", keyword: "type", params: { type: schema145.properties.mfa_code.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs2 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.proof !== void 0) {
              let data2 = data.proof;
              const _errs4 = errors;
              const _errs5 = errors;
              if (errors === _errs5) {
                if (data2 && typeof data2 == "object" && !Array.isArray(data2)) {
                  let missing1;
                  if (data2.nonce === void 0 && (missing1 = "nonce") || data2.timestamp === void 0 && (missing1 = "timestamp") || data2.signature === void 0 && (missing1 = "signature")) {
                    validate99.errors = [{ instancePath: instancePath + "/proof", schemaPath: "#/$defs/IdentityProof/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                    return false;
                  } else {
                    if (data2.nonce !== void 0) {
                      const _errs7 = errors;
                      if (typeof data2.nonce !== "string") {
                        validate99.errors = [{ instancePath: instancePath + "/proof/nonce", schemaPath: "#/$defs/IdentityProof/properties/nonce/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                        return false;
                      }
                      var valid2 = _errs7 === errors;
                    } else {
                      var valid2 = true;
                    }
                    if (valid2) {
                      if (data2.signature !== void 0) {
                        const _errs9 = errors;
                        if (typeof data2.signature !== "string") {
                          validate99.errors = [{ instancePath: instancePath + "/proof/signature", schemaPath: "#/$defs/IdentityProof/properties/signature/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                          return false;
                        }
                        var valid2 = _errs9 === errors;
                      } else {
                        var valid2 = true;
                      }
                      if (valid2) {
                        if (data2.timestamp !== void 0) {
                          let data5 = data2.timestamp;
                          const _errs11 = errors;
                          if (!(typeof data5 == "number" && (!(data5 % 1) && !isNaN(data5)) && isFinite(data5))) {
                            validate99.errors = [{ instancePath: instancePath + "/proof/timestamp", schemaPath: "#/$defs/IdentityProof/properties/timestamp/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                            return false;
                          }
                          var valid2 = _errs11 === errors;
                        } else {
                          var valid2 = true;
                        }
                      }
                    }
                  }
                } else {
                  validate99.errors = [{ instancePath: instancePath + "/proof", schemaPath: "#/$defs/IdentityProof/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                  return false;
                }
              }
              var valid0 = _errs4 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.wrapped_key !== void 0) {
                const _errs13 = errors;
                if (typeof data.wrapped_key !== "string") {
                  validate99.errors = [{ instancePath: instancePath + "/wrapped_key", schemaPath: "#/properties/wrapped_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
    } else {
      validate99.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate99.errors = vErrors;
  return errors === 0;
}
validate99.evaluated = { "props": { "credential": true, "mfa_code": true, "proof": true, "wrapped_key": true }, "dynamicProps": false, "dynamicItems": false };
var isStartVoiceViewRequest = validate102;
var schema150 = { "description": "What a view session receives.\n\n- `watch`: the chosen stream's video and its own audio (never the voices).\n  Counted in the channel's watcher counts, so others see \"2 watching\".\n- `ambient`: the stream's lowest simulcast layer, keyframes only, at most\n  one frame a second, video only. Not counted and not shown to anybody.", "enum": ["watch", "ambient"], "type": "string" };
function validate102(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate102.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.kind === void 0 && (missing0 = "kind") || data.user_id === void 0 && (missing0 = "user_id")) {
        validate102.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.kind !== void 0) {
          let data0 = data.kind;
          const _errs1 = errors;
          if (typeof data0 !== "string") {
            validate102.errors = [{ instancePath: instancePath + "/kind", schemaPath: "#/$defs/VoiceViewKind/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          if (!(data0 === "watch" || data0 === "ambient")) {
            validate102.errors = [{ instancePath: instancePath + "/kind", schemaPath: "#/$defs/VoiceViewKind/enum", keyword: "enum", params: { allowedValues: schema150.enum }, message: "must be equal to one of the allowed values" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.user_id !== void 0) {
            let data1 = data.user_id;
            const _errs4 = errors;
            if (errors === _errs4) {
              if (typeof data1 === "string") {
                if (func1(data1) < 1) {
                  validate102.errors = [{ instancePath: instancePath + "/user_id", schemaPath: "#/properties/user_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                } else {
                  if (!pattern4.test(data1)) {
                    validate102.errors = [{ instancePath: instancePath + "/user_id", schemaPath: "#/properties/user_id/pattern", keyword: "pattern", params: { pattern: "^[0-9]+$" }, message: 'must match pattern "^[0-9]+$"' }];
                    return false;
                  }
                }
              } else {
                validate102.errors = [{ instancePath: instancePath + "/user_id", schemaPath: "#/properties/user_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
            }
            var valid0 = _errs4 === errors;
          } else {
            var valid0 = true;
          }
        }
      }
    } else {
      validate102.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate102.errors = vErrors;
  return errors === 0;
}
validate102.evaluated = { "props": { "kind": true, "user_id": true }, "dynamicProps": false, "dynamicItems": false };
var isStorageKeyEscrowRequest = validate103;
function validate103(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate103.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.wrapping_key === void 0 && (missing0 = "wrapping_key")) {
        validate103.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.wrapping_key !== void 0) {
          if (typeof data.wrapping_key !== "string") {
            validate103.errors = [{ instancePath: instancePath + "/wrapping_key", schemaPath: "#/properties/wrapping_key/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
        }
      }
    } else {
      validate103.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate103.errors = vErrors;
  return errors === 0;
}
validate103.evaluated = { "props": { "wrapping_key": true }, "dynamicProps": false, "dynamicItems": false };
var isTransferOwnershipRequest = validate104;
function validate104(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate104.evaluated;
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
        validate104.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.new_owner_id !== void 0) {
          if (typeof data.new_owner_id !== "string") {
            validate104.errors = [{ instancePath: instancePath + "/new_owner_id", schemaPath: "#/properties/new_owner_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
        }
      }
    } else {
      validate104.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate104.errors = vErrors;
  return errors === 0;
}
validate104.evaluated = { "props": { "new_owner_id": true }, "dynamicProps": false, "dynamicItems": false };
var isUpdateBackupsRequest = validate105;
function validate105(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate105.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.enabled === void 0 && (missing0 = "enabled")) {
        validate105.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.enabled !== void 0) {
          if (typeof data.enabled !== "boolean") {
            validate105.errors = [{ instancePath: instancePath + "/enabled", schemaPath: "#/properties/enabled/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
            return false;
          }
        }
      }
    } else {
      validate105.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate105.errors = vErrors;
  return errors === 0;
}
validate105.evaluated = { "props": { "enabled": true }, "dynamicProps": false, "dynamicItems": false };
var isUpdatedCurrentUser = validate106;
var schema154 = { "$id": "urn:paracord:contract:UpdatedCurrentUser", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "`PATCH /users/@me` and `POST /users/@me/avatar`: the updated account fields.\nSettings-derived extras (pronouns, linked accounts) and key metadata are\nonly returned by `GET /users/@me`.", "properties": { "accent_color": { "description": "Profile accent as `0xRRGGBB`. Omitted when the member has not chosen one.\n\nNew in 3.2. Unlike the other nullable fields it may be absent rather\nthan null, so a 3.2 client can still read accounts from a 3.1 instance,\nwhich never sends it.", "format": "int32", "type": ["integer", "null"] }, "avatar_hash": { "type": ["string", "null"] }, "banner_hash": { "type": ["string", "null"] }, "bio": { "type": ["string", "null"] }, "bot": { "type": "boolean" }, "created_at": { "type": "string" }, "discriminator": { "format": "int32", "type": "integer" }, "display_name": { "type": ["string", "null"] }, "email": { "type": "string" }, "flags": { "format": "int32", "type": "integer" }, "id": { "type": "string" }, "system": { "type": "boolean" }, "username": { "type": "string" } }, "required": ["id", "username", "discriminator", "display_name", "avatar_hash", "banner_hash", "bio", "flags", "bot", "system", "created_at", "email"], "title": "UpdatedCurrentUser", "type": "object" };
function validate106(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate106.evaluated;
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
        validate106.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.accent_color !== void 0) {
          let data0 = data.accent_color;
          const _errs1 = errors;
          if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)) && isFinite(data0)) && data0 !== null) {
            validate106.errors = [{ instancePath: instancePath + "/accent_color", schemaPath: "#/properties/accent_color/type", keyword: "type", params: { type: schema154.properties.accent_color.type }, message: "must be integer,null" }];
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
              validate106.errors = [{ instancePath: instancePath + "/avatar_hash", schemaPath: "#/properties/avatar_hash/type", keyword: "type", params: { type: schema154.properties.avatar_hash.type }, message: "must be string,null" }];
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
                validate106.errors = [{ instancePath: instancePath + "/banner_hash", schemaPath: "#/properties/banner_hash/type", keyword: "type", params: { type: schema154.properties.banner_hash.type }, message: "must be string,null" }];
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
                  validate106.errors = [{ instancePath: instancePath + "/bio", schemaPath: "#/properties/bio/type", keyword: "type", params: { type: schema154.properties.bio.type }, message: "must be string,null" }];
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
                    validate106.errors = [{ instancePath: instancePath + "/bot", schemaPath: "#/properties/bot/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
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
                      validate106.errors = [{ instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                        validate106.errors = [{ instancePath: instancePath + "/discriminator", schemaPath: "#/properties/discriminator/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
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
                          validate106.errors = [{ instancePath: instancePath + "/display_name", schemaPath: "#/properties/display_name/type", keyword: "type", params: { type: schema154.properties.display_name.type }, message: "must be string,null" }];
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
                            validate106.errors = [{ instancePath: instancePath + "/email", schemaPath: "#/properties/email/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                              validate106.errors = [{ instancePath: instancePath + "/flags", schemaPath: "#/properties/flags/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
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
                                validate106.errors = [{ instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                                  validate106.errors = [{ instancePath: instancePath + "/system", schemaPath: "#/properties/system/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
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
                                    validate106.errors = [{ instancePath: instancePath + "/username", schemaPath: "#/properties/username/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
      validate106.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate106.errors = vErrors;
  return errors === 0;
}
validate106.evaluated = { "props": { "accent_color": true, "avatar_hash": true, "banner_hash": true, "bio": true, "bot": true, "created_at": true, "discriminator": true, "display_name": true, "email": true, "flags": true, "id": true, "system": true, "username": true }, "dynamicProps": false, "dynamicItems": false };
var isUpdateEmojiRequest = validate107;
function validate107(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate107.evaluated;
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
        validate107.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.name !== void 0) {
          if (typeof data.name !== "string") {
            validate107.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
        }
      }
    } else {
      validate107.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate107.errors = vErrors;
  return errors === 0;
}
validate107.evaluated = { "props": { "name": true }, "dynamicProps": false, "dynamicItems": false };
var isUpdateGuildRequest = validate108;
var schema156 = { "$defs": { "GuildBotConfig": { "additionalProperties": true, "properties": { "enabled": { "type": ["boolean", "null"] } }, "type": "object" }, "HubSettings": { "additionalProperties": true, "properties": { "description": { "type": ["string", "null"] }, "pinned_channels": { "items": { "type": "string" }, "type": ["array", "null"] }, "welcome_text": { "type": ["string", "null"] } }, "type": "object" } }, "$id": "urn:paracord:contract:UpdateGuildRequest", "$schema": "https://json-schema.org/draft/2020-12/schema", "properties": { "allowed_roles": { "items": { "type": "string" }, "type": ["array", "null"] }, "bot_settings": { "additionalProperties": { "$ref": "#/$defs/GuildBotConfig" }, "type": ["object", "null"] }, "description": { "type": ["string", "null"] }, "discovery_tags": { "items": { "type": "string" }, "type": ["array", "null"] }, "hub_settings": { "anyOf": [{ "$ref": "#/$defs/HubSettings" }, { "type": "null" }] }, "hue": { "default": null, "description": "The server's color as a hue, 0-359 (Manage Server). `null` clears it;\nomit the field to leave it unchanged. Out of range is a 400.", "format": "int32", "maximum": 359, "minimum": 0, "type": ["integer", "null"] }, "icon": { "type": ["string", "null"] }, "name": { "type": ["string", "null"] }, "visibility": { "type": ["string", "null"] } }, "title": "UpdateGuildRequest", "type": "object" };
var schema157 = { "additionalProperties": true, "properties": { "enabled": { "type": ["boolean", "null"] } }, "type": "object" };
var schema158 = { "additionalProperties": true, "properties": { "description": { "type": ["string", "null"] }, "pinned_channels": { "items": { "type": "string" }, "type": ["array", "null"] }, "welcome_text": { "type": ["string", "null"] } }, "type": "object" };
function validate108(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate108.evaluated;
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
          validate108.errors = [{ instancePath: instancePath + "/allowed_roles", schemaPath: "#/properties/allowed_roles/type", keyword: "type", params: { type: schema156.properties.allowed_roles.type }, message: "must be array,null" }];
          return false;
        }
        if (errors === _errs1) {
          if (Array.isArray(data0)) {
            var valid1 = true;
            const len0 = data0.length;
            for (let i0 = 0; i0 < len0; i0++) {
              const _errs3 = errors;
              if (typeof data0[i0] !== "string") {
                validate108.errors = [{ instancePath: instancePath + "/allowed_roles/" + i0, schemaPath: "#/properties/allowed_roles/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
            validate108.errors = [{ instancePath: instancePath + "/bot_settings", schemaPath: "#/properties/bot_settings/type", keyword: "type", params: { type: schema156.properties.bot_settings.type }, message: "must be object,null" }];
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
                        validate108.errors = [{ instancePath: instancePath + "/bot_settings/" + key0.replace(/~/g, "~0").replace(/\//g, "~1") + "/enabled", schemaPath: "#/$defs/GuildBotConfig/properties/enabled/type", keyword: "type", params: { type: schema157.properties.enabled.type }, message: "must be boolean,null" }];
                        return false;
                      }
                    }
                  } else {
                    validate108.errors = [{ instancePath: instancePath + "/bot_settings/" + key0.replace(/~/g, "~0").replace(/\//g, "~1"), schemaPath: "#/$defs/GuildBotConfig/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
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
              validate108.errors = [{ instancePath: instancePath + "/description", schemaPath: "#/properties/description/type", keyword: "type", params: { type: schema156.properties.description.type }, message: "must be string,null" }];
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
                validate108.errors = [{ instancePath: instancePath + "/discovery_tags", schemaPath: "#/properties/discovery_tags/type", keyword: "type", params: { type: schema156.properties.discovery_tags.type }, message: "must be array,null" }];
                return false;
              }
              if (errors === _errs16) {
                if (Array.isArray(data6)) {
                  var valid5 = true;
                  const len1 = data6.length;
                  for (let i1 = 0; i1 < len1; i1++) {
                    const _errs18 = errors;
                    if (typeof data6[i1] !== "string") {
                      validate108.errors = [{ instancePath: instancePath + "/discovery_tags/" + i1, schemaPath: "#/properties/discovery_tags/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
                        const err0 = { instancePath: instancePath + "/hub_settings/description", schemaPath: "#/$defs/HubSettings/properties/description/type", keyword: "type", params: { type: schema158.properties.description.type }, message: "must be string,null" };
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
                          const err1 = { instancePath: instancePath + "/hub_settings/pinned_channels", schemaPath: "#/$defs/HubSettings/properties/pinned_channels/type", keyword: "type", params: { type: schema158.properties.pinned_channels.type }, message: "must be array,null" };
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
                            const err3 = { instancePath: instancePath + "/hub_settings/welcome_text", schemaPath: "#/$defs/HubSettings/properties/welcome_text/type", keyword: "type", params: { type: schema158.properties.welcome_text.type }, message: "must be string,null" };
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
                  validate108.errors = vErrors;
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
                if (data.hue !== void 0) {
                  let data13 = data.hue;
                  const _errs36 = errors;
                  if (!(typeof data13 == "number" && (!(data13 % 1) && !isNaN(data13)) && isFinite(data13)) && data13 !== null) {
                    validate108.errors = [{ instancePath: instancePath + "/hue", schemaPath: "#/properties/hue/type", keyword: "type", params: { type: schema156.properties.hue.type }, message: "must be integer,null" }];
                    return false;
                  }
                  if (errors === _errs36) {
                    if (typeof data13 == "number" && isFinite(data13)) {
                      if (data13 > 359 || isNaN(data13)) {
                        validate108.errors = [{ instancePath: instancePath + "/hue", schemaPath: "#/properties/hue/maximum", keyword: "maximum", params: { comparison: "<=", limit: 359 }, message: "must be <= 359" }];
                        return false;
                      } else {
                        if (data13 < 0 || isNaN(data13)) {
                          validate108.errors = [{ instancePath: instancePath + "/hue", schemaPath: "#/properties/hue/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" }];
                          return false;
                        }
                      }
                    }
                  }
                  var valid0 = _errs36 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.icon !== void 0) {
                    let data14 = data.icon;
                    const _errs38 = errors;
                    if (typeof data14 !== "string" && data14 !== null) {
                      validate108.errors = [{ instancePath: instancePath + "/icon", schemaPath: "#/properties/icon/type", keyword: "type", params: { type: schema156.properties.icon.type }, message: "must be string,null" }];
                      return false;
                    }
                    var valid0 = _errs38 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.name !== void 0) {
                      let data15 = data.name;
                      const _errs40 = errors;
                      if (typeof data15 !== "string" && data15 !== null) {
                        validate108.errors = [{ instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: schema156.properties.name.type }, message: "must be string,null" }];
                        return false;
                      }
                      var valid0 = _errs40 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.visibility !== void 0) {
                        let data16 = data.visibility;
                        const _errs42 = errors;
                        if (typeof data16 !== "string" && data16 !== null) {
                          validate108.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/properties/visibility/type", keyword: "type", params: { type: schema156.properties.visibility.type }, message: "must be string,null" }];
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
    } else {
      validate108.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate108.errors = vErrors;
  return errors === 0;
}
validate108.evaluated = { "props": { "allowed_roles": true, "bot_settings": true, "description": true, "discovery_tags": true, "hub_settings": true, "hue": true, "icon": true, "name": true, "visibility": true }, "dynamicProps": false, "dynamicItems": false };
var isUpdateMeRequest = validate109;
var schema159 = { "$id": "urn:paracord:contract:UpdateMeRequest", "$schema": "https://json-schema.org/draft/2020-12/schema", "properties": { "accent_color": { "default": null, "description": "Profile accent as `0xRRGGBB`. `null` clears it. Omit the field to leave\nthe stored color unchanged.", "format": "int32", "type": ["integer", "null"] }, "avatar_hash": { "description": "Legacy data-URL avatars are still accepted for backward compatibility,\nbut clients should prefer `POST /users/@me/avatar`.", "type": ["string", "null"] }, "bio": { "type": ["string", "null"] }, "display_name": { "type": ["string", "null"] } }, "title": "UpdateMeRequest", "type": "object" };
function validate109(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate109.evaluated;
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
          validate109.errors = [{ instancePath: instancePath + "/accent_color", schemaPath: "#/properties/accent_color/type", keyword: "type", params: { type: schema159.properties.accent_color.type }, message: "must be integer,null" }];
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
            validate109.errors = [{ instancePath: instancePath + "/avatar_hash", schemaPath: "#/properties/avatar_hash/type", keyword: "type", params: { type: schema159.properties.avatar_hash.type }, message: "must be string,null" }];
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
              validate109.errors = [{ instancePath: instancePath + "/bio", schemaPath: "#/properties/bio/type", keyword: "type", params: { type: schema159.properties.bio.type }, message: "must be string,null" }];
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
                validate109.errors = [{ instancePath: instancePath + "/display_name", schemaPath: "#/properties/display_name/type", keyword: "type", params: { type: schema159.properties.display_name.type }, message: "must be string,null" }];
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
      validate109.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate109.errors = vErrors;
  return errors === 0;
}
validate109.evaluated = { "props": { "accent_color": true, "avatar_hash": true, "bio": true, "display_name": true }, "dynamicProps": false, "dynamicItems": false };
var isUpdateSettingsRequest = validate110;
var schema160 = { "$id": "urn:paracord:contract:UpdateSettingsRequest", "$schema": "https://json-schema.org/draft/2020-12/schema", "properties": { "crypto_auth_enabled": { "type": ["boolean", "null"] }, "custom_css": { "type": ["string", "null"] }, "custom_status": { "type": ["string", "null"] }, "keybinds": true, "link_previews": { "default": null, "description": "Whether links this person posts are unfurled into previews, and whether\nthey see previews (spec \xA78.3). Stored in `user_settings.link_previews`.", "type": ["boolean", "null"] }, "locale": { "type": ["string", "null"] }, "message_display_compact": { "type": ["boolean", "null"] }, "notifications": true, "status": { "type": ["string", "null"] }, "theme": { "type": ["string", "null"] } }, "title": "UpdateSettingsRequest", "type": "object" };
function validate110(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate110.evaluated;
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
          validate110.errors = [{ instancePath: instancePath + "/crypto_auth_enabled", schemaPath: "#/properties/crypto_auth_enabled/type", keyword: "type", params: { type: schema160.properties.crypto_auth_enabled.type }, message: "must be boolean,null" }];
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
            validate110.errors = [{ instancePath: instancePath + "/custom_css", schemaPath: "#/properties/custom_css/type", keyword: "type", params: { type: schema160.properties.custom_css.type }, message: "must be string,null" }];
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
              validate110.errors = [{ instancePath: instancePath + "/custom_status", schemaPath: "#/properties/custom_status/type", keyword: "type", params: { type: schema160.properties.custom_status.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs5 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.link_previews !== void 0) {
              let data3 = data.link_previews;
              const _errs7 = errors;
              if (typeof data3 !== "boolean" && data3 !== null) {
                validate110.errors = [{ instancePath: instancePath + "/link_previews", schemaPath: "#/properties/link_previews/type", keyword: "type", params: { type: schema160.properties.link_previews.type }, message: "must be boolean,null" }];
                return false;
              }
              var valid0 = _errs7 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.locale !== void 0) {
                let data4 = data.locale;
                const _errs9 = errors;
                if (typeof data4 !== "string" && data4 !== null) {
                  validate110.errors = [{ instancePath: instancePath + "/locale", schemaPath: "#/properties/locale/type", keyword: "type", params: { type: schema160.properties.locale.type }, message: "must be string,null" }];
                  return false;
                }
                var valid0 = _errs9 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.message_display_compact !== void 0) {
                  let data5 = data.message_display_compact;
                  const _errs11 = errors;
                  if (typeof data5 !== "boolean" && data5 !== null) {
                    validate110.errors = [{ instancePath: instancePath + "/message_display_compact", schemaPath: "#/properties/message_display_compact/type", keyword: "type", params: { type: schema160.properties.message_display_compact.type }, message: "must be boolean,null" }];
                    return false;
                  }
                  var valid0 = _errs11 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.status !== void 0) {
                    let data6 = data.status;
                    const _errs13 = errors;
                    if (typeof data6 !== "string" && data6 !== null) {
                      validate110.errors = [{ instancePath: instancePath + "/status", schemaPath: "#/properties/status/type", keyword: "type", params: { type: schema160.properties.status.type }, message: "must be string,null" }];
                      return false;
                    }
                    var valid0 = _errs13 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.theme !== void 0) {
                      let data7 = data.theme;
                      const _errs15 = errors;
                      if (typeof data7 !== "string" && data7 !== null) {
                        validate110.errors = [{ instancePath: instancePath + "/theme", schemaPath: "#/properties/theme/type", keyword: "type", params: { type: schema160.properties.theme.type }, message: "must be string,null" }];
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
    } else {
      validate110.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate110.errors = vErrors;
  return errors === 0;
}
validate110.evaluated = { "props": { "crypto_auth_enabled": true, "custom_css": true, "custom_status": true, "keybinds": true, "link_previews": true, "locale": true, "message_display_compact": true, "notifications": true, "status": true, "theme": true }, "dynamicProps": false, "dynamicItems": false };
var isUpdateVoiceModeRequest = validate111;
var schema161 = { "$defs": { "VoiceMode": { "description": "How a member takes part in a voice channel. `listen` hears the voices and\nnever sends; everyone in the channel sees the member as listening in.", "enum": ["joined", "listen"], "type": "string" } }, "$id": "urn:paracord:contract:UpdateVoiceModeRequest", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "`POST /api/v2/voice/{channel_id}/mode`: switch between listening in and a\nfull membership in place (no reconnect).", "properties": { "mode": { "$ref": "#/$defs/VoiceMode" }, "session_id": { "description": "The call receipt from the join. When present the switch applies only\nto that call (409 otherwise).", "type": ["string", "null"] } }, "required": ["mode"], "title": "UpdateVoiceModeRequest", "type": "object" };
var schema162 = { "description": "How a member takes part in a voice channel. `listen` hears the voices and\nnever sends; everyone in the channel sees the member as listening in.", "enum": ["joined", "listen"], "type": "string" };
function validate111(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate111.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.mode === void 0 && (missing0 = "mode")) {
        validate111.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.mode !== void 0) {
          let data0 = data.mode;
          const _errs1 = errors;
          if (typeof data0 !== "string") {
            validate111.errors = [{ instancePath: instancePath + "/mode", schemaPath: "#/$defs/VoiceMode/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
          if (!(data0 === "joined" || data0 === "listen")) {
            validate111.errors = [{ instancePath: instancePath + "/mode", schemaPath: "#/$defs/VoiceMode/enum", keyword: "enum", params: { allowedValues: schema162.enum }, message: "must be equal to one of the allowed values" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.session_id !== void 0) {
            let data1 = data.session_id;
            const _errs4 = errors;
            if (typeof data1 !== "string" && data1 !== null) {
              validate111.errors = [{ instancePath: instancePath + "/session_id", schemaPath: "#/properties/session_id/type", keyword: "type", params: { type: schema161.properties.session_id.type }, message: "must be string,null" }];
              return false;
            }
            var valid0 = _errs4 === errors;
          } else {
            var valid0 = true;
          }
        }
      }
    } else {
      validate111.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate111.errors = vErrors;
  return errors === 0;
}
validate111.evaluated = { "props": { "mode": true, "session_id": true }, "dynamicProps": false, "dynamicItems": false };
var isUserSettingsResponse = validate112;
var schema163 = { "$id": "urn:paracord:contract:UserSettingsResponse", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "`GET`/`PATCH /users/@me/settings`. The server stores `theme`, `locale`, and\n`status` as opaque strings (bounded by length only), and `notifications` and\n`keybinds` as free-form JSON objects; they are echoed verbatim.", "properties": { "crypto_auth_enabled": { "type": "boolean" }, "custom_css": { "type": ["string", "null"] }, "custom_status": { "type": ["string", "null"] }, "keybinds": { "additionalProperties": true, "type": "object" }, "link_previews": { "description": "Link previews on for this person (spec \xA78.3).", "type": "boolean" }, "link_previews_available": { "description": 'The server fetches previews at all (`[link_previews] enabled`). When\nfalse the switch is disabled with "Turned off on this server."', "type": "boolean" }, "locale": { "type": "string" }, "message_display_compact": { "type": "boolean" }, "notifications": { "additionalProperties": true, "type": "object" }, "status": { "type": "string" }, "theme": { "type": "string" }, "user_id": { "type": "string" } }, "required": ["user_id", "theme", "locale", "message_display_compact", "custom_css", "status", "custom_status", "crypto_auth_enabled", "link_previews", "link_previews_available", "notifications", "keybinds"], "title": "UserSettingsResponse", "type": "object" };
function validate112(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate112.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.user_id === void 0 && (missing0 = "user_id") || data.theme === void 0 && (missing0 = "theme") || data.locale === void 0 && (missing0 = "locale") || data.message_display_compact === void 0 && (missing0 = "message_display_compact") || data.custom_css === void 0 && (missing0 = "custom_css") || data.status === void 0 && (missing0 = "status") || data.custom_status === void 0 && (missing0 = "custom_status") || data.crypto_auth_enabled === void 0 && (missing0 = "crypto_auth_enabled") || data.link_previews === void 0 && (missing0 = "link_previews") || data.link_previews_available === void 0 && (missing0 = "link_previews_available") || data.notifications === void 0 && (missing0 = "notifications") || data.keybinds === void 0 && (missing0 = "keybinds")) {
        validate112.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.crypto_auth_enabled !== void 0) {
          const _errs1 = errors;
          if (typeof data.crypto_auth_enabled !== "boolean") {
            validate112.errors = [{ instancePath: instancePath + "/crypto_auth_enabled", schemaPath: "#/properties/crypto_auth_enabled/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
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
              validate112.errors = [{ instancePath: instancePath + "/custom_css", schemaPath: "#/properties/custom_css/type", keyword: "type", params: { type: schema163.properties.custom_css.type }, message: "must be string,null" }];
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
                validate112.errors = [{ instancePath: instancePath + "/custom_status", schemaPath: "#/properties/custom_status/type", keyword: "type", params: { type: schema163.properties.custom_status.type }, message: "must be string,null" }];
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
                    validate112.errors = [{ instancePath: instancePath + "/keybinds", schemaPath: "#/properties/keybinds/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                    return false;
                  }
                }
                var valid0 = _errs7 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.link_previews !== void 0) {
                  const _errs10 = errors;
                  if (typeof data.link_previews !== "boolean") {
                    validate112.errors = [{ instancePath: instancePath + "/link_previews", schemaPath: "#/properties/link_previews/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                    return false;
                  }
                  var valid0 = _errs10 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.link_previews_available !== void 0) {
                    const _errs12 = errors;
                    if (typeof data.link_previews_available !== "boolean") {
                      validate112.errors = [{ instancePath: instancePath + "/link_previews_available", schemaPath: "#/properties/link_previews_available/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                      return false;
                    }
                    var valid0 = _errs12 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.locale !== void 0) {
                      const _errs14 = errors;
                      if (typeof data.locale !== "string") {
                        validate112.errors = [{ instancePath: instancePath + "/locale", schemaPath: "#/properties/locale/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                        return false;
                      }
                      var valid0 = _errs14 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.message_display_compact !== void 0) {
                        const _errs16 = errors;
                        if (typeof data.message_display_compact !== "boolean") {
                          validate112.errors = [{ instancePath: instancePath + "/message_display_compact", schemaPath: "#/properties/message_display_compact/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                          return false;
                        }
                        var valid0 = _errs16 === errors;
                      } else {
                        var valid0 = true;
                      }
                      if (valid0) {
                        if (data.notifications !== void 0) {
                          let data8 = data.notifications;
                          const _errs18 = errors;
                          if (errors === _errs18) {
                            if (data8 && typeof data8 == "object" && !Array.isArray(data8)) {
                            } else {
                              validate112.errors = [{ instancePath: instancePath + "/notifications", schemaPath: "#/properties/notifications/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                              return false;
                            }
                          }
                          var valid0 = _errs18 === errors;
                        } else {
                          var valid0 = true;
                        }
                        if (valid0) {
                          if (data.status !== void 0) {
                            const _errs21 = errors;
                            if (typeof data.status !== "string") {
                              validate112.errors = [{ instancePath: instancePath + "/status", schemaPath: "#/properties/status/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                              return false;
                            }
                            var valid0 = _errs21 === errors;
                          } else {
                            var valid0 = true;
                          }
                          if (valid0) {
                            if (data.theme !== void 0) {
                              const _errs23 = errors;
                              if (typeof data.theme !== "string") {
                                validate112.errors = [{ instancePath: instancePath + "/theme", schemaPath: "#/properties/theme/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                return false;
                              }
                              var valid0 = _errs23 === errors;
                            } else {
                              var valid0 = true;
                            }
                            if (valid0) {
                              if (data.user_id !== void 0) {
                                const _errs25 = errors;
                                if (typeof data.user_id !== "string") {
                                  validate112.errors = [{ instancePath: instancePath + "/user_id", schemaPath: "#/properties/user_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
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
    } else {
      validate112.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate112.errors = vErrors;
  return errors === 0;
}
validate112.evaluated = { "props": { "crypto_auth_enabled": true, "custom_css": true, "custom_status": true, "keybinds": true, "link_previews": true, "link_previews_available": true, "locale": true, "message_display_compact": true, "notifications": true, "status": true, "theme": true, "user_id": true }, "dynamicProps": false, "dynamicItems": false };
var isVoiceModeResponse = validate113;
var schema165 = { "description": "How a member takes part in a voice channel. `listen` hears the voices and\nnever sends; everyone in the channel sees the member as listening in.", "enum": ["joined", "listen"], "type": "string" };
function validate113(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate113.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.channel_id === void 0 && (missing0 = "channel_id") || data.session_id === void 0 && (missing0 = "session_id") || data.mode === void 0 && (missing0 = "mode") || data.can_publish === void 0 && (missing0 = "can_publish")) {
        validate113.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.can_publish !== void 0) {
          const _errs1 = errors;
          if (typeof data.can_publish !== "boolean") {
            validate113.errors = [{ instancePath: instancePath + "/can_publish", schemaPath: "#/properties/can_publish/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.channel_id !== void 0) {
            let data1 = data.channel_id;
            const _errs3 = errors;
            if (errors === _errs3) {
              if (typeof data1 === "string") {
                if (func1(data1) < 1) {
                  validate113.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                } else {
                  if (!pattern4.test(data1)) {
                    validate113.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/pattern", keyword: "pattern", params: { pattern: "^[0-9]+$" }, message: 'must match pattern "^[0-9]+$"' }];
                    return false;
                  }
                }
              } else {
                validate113.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.mode !== void 0) {
              let data2 = data.mode;
              const _errs5 = errors;
              if (typeof data2 !== "string") {
                validate113.errors = [{ instancePath: instancePath + "/mode", schemaPath: "#/$defs/VoiceMode/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              if (!(data2 === "joined" || data2 === "listen")) {
                validate113.errors = [{ instancePath: instancePath + "/mode", schemaPath: "#/$defs/VoiceMode/enum", keyword: "enum", params: { allowedValues: schema165.enum }, message: "must be equal to one of the allowed values" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.session_id !== void 0) {
                let data3 = data.session_id;
                const _errs8 = errors;
                if (errors === _errs8) {
                  if (typeof data3 === "string") {
                    if (func1(data3) < 1) {
                      validate113.errors = [{ instancePath: instancePath + "/session_id", schemaPath: "#/properties/session_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                      return false;
                    }
                  } else {
                    validate113.errors = [{ instancePath: instancePath + "/session_id", schemaPath: "#/properties/session_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                }
                var valid0 = _errs8 === errors;
              } else {
                var valid0 = true;
              }
            }
          }
        }
      }
    } else {
      validate113.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate113.errors = vErrors;
  return errors === 0;
}
validate113.evaluated = { "props": { "can_publish": true, "channel_id": true, "mode": true, "session_id": true }, "dynamicProps": false, "dynamicItems": false };
var isVoiceStateSnapshot = validate114;
var schema166 = { "$defs": { "VoiceMode": { "description": "How a member takes part in a voice channel. `listen` hears the voices and\nnever sends; everyone in the channel sees the member as listening in.", "enum": ["joined", "listen"], "type": "string" } }, "$id": "urn:paracord:contract:VoiceStateSnapshot", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "A voice state as READY lists it (`guilds[].voice_states[]`) and as a\n`VOICE_STATE_UPDATE` for someone *in* a channel carries it. (A leave is\n`channel_id: null` plus `prior_channel_id` and is not this shape.)", "properties": { "avatar_hash": { "type": ["string", "null"] }, "channel_id": { "minLength": 1, "pattern": "^[0-9]+$", "type": "string" }, "deaf": { "default": false, "type": "boolean" }, "guild_id": { "description": "Null for a DM call.", "type": ["string", "null"] }, "joined_at": { "default": null, "description": 'When the member entered this channel (RFC 3339), for "live 12 min" on a\nroom: the room started at the earliest `joined_at` among its members.\nStamped on every join and listen join, kept while the member stays in\nthe channel, reset by a move. Null only on a status announcement whose\nstored row could not be read.', "type": ["string", "null"] }, "mode": { "$ref": "#/$defs/VoiceMode", "default": "joined", "description": '`listen` shows as "Listening in" on the roster.\n\n`mode`, `self_stream_started_at` and `joined_at` are always sent by this\nserver. They are optional in the contract for protocol-version\ntolerance: servers from before them leave them out. An\nabsent `mode` is `joined` (there was no listening in); an absent time is\nunknown, exactly as null, and a client shows nothing it would have\nderived from it (a room reads "live", not "live N min").' }, "mute": { "default": false, "type": "boolean" }, "request_to_speak_at": { "type": ["string", "null"] }, "self_deaf": { "type": "boolean" }, "self_mute": { "type": "boolean" }, "self_stream": { "type": "boolean" }, "self_stream_started_at": { "default": null, "description": 'When the member\'s current stream started (RFC 3339), for "LIVE 42 MIN".\nNon-null exactly while `self_stream` is true (when sent at all).', "type": ["string", "null"] }, "self_video": { "type": "boolean" }, "session_id": { "type": ["string", "null"] }, "speaking": { "description": "READY only: talking right now.", "type": ["boolean", "null"] }, "suppress": { "type": "boolean" }, "user_id": { "minLength": 1, "pattern": "^[0-9]+$", "type": "string" }, "username": { "type": ["string", "null"] } }, "required": ["user_id", "channel_id", "guild_id", "self_mute", "self_deaf", "self_stream", "self_video", "suppress", "mute", "deaf"], "title": "VoiceStateSnapshot", "type": "object" };
var schema167 = { "description": "How a member takes part in a voice channel. `listen` hears the voices and\nnever sends; everyone in the channel sees the member as listening in.", "enum": ["joined", "listen"], "type": "string" };
function validate114(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate114.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.user_id === void 0 && (missing0 = "user_id") || data.channel_id === void 0 && (missing0 = "channel_id") || data.guild_id === void 0 && (missing0 = "guild_id") || data.self_mute === void 0 && (missing0 = "self_mute") || data.self_deaf === void 0 && (missing0 = "self_deaf") || data.self_stream === void 0 && (missing0 = "self_stream") || data.self_video === void 0 && (missing0 = "self_video") || data.suppress === void 0 && (missing0 = "suppress") || data.mute === void 0 && (missing0 = "mute") || data.deaf === void 0 && (missing0 = "deaf")) {
        validate114.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.avatar_hash !== void 0) {
          let data0 = data.avatar_hash;
          const _errs1 = errors;
          if (typeof data0 !== "string" && data0 !== null) {
            validate114.errors = [{ instancePath: instancePath + "/avatar_hash", schemaPath: "#/properties/avatar_hash/type", keyword: "type", params: { type: schema166.properties.avatar_hash.type }, message: "must be string,null" }];
            return false;
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.channel_id !== void 0) {
            let data1 = data.channel_id;
            const _errs3 = errors;
            if (errors === _errs3) {
              if (typeof data1 === "string") {
                if (func1(data1) < 1) {
                  validate114.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                } else {
                  if (!pattern4.test(data1)) {
                    validate114.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/pattern", keyword: "pattern", params: { pattern: "^[0-9]+$" }, message: 'must match pattern "^[0-9]+$"' }];
                    return false;
                  }
                }
              } else {
                validate114.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.deaf !== void 0) {
              const _errs5 = errors;
              if (typeof data.deaf !== "boolean") {
                validate114.errors = [{ instancePath: instancePath + "/deaf", schemaPath: "#/properties/deaf/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.guild_id !== void 0) {
                let data3 = data.guild_id;
                const _errs7 = errors;
                if (typeof data3 !== "string" && data3 !== null) {
                  validate114.errors = [{ instancePath: instancePath + "/guild_id", schemaPath: "#/properties/guild_id/type", keyword: "type", params: { type: schema166.properties.guild_id.type }, message: "must be string,null" }];
                  return false;
                }
                var valid0 = _errs7 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.joined_at !== void 0) {
                  let data4 = data.joined_at;
                  const _errs9 = errors;
                  if (typeof data4 !== "string" && data4 !== null) {
                    validate114.errors = [{ instancePath: instancePath + "/joined_at", schemaPath: "#/properties/joined_at/type", keyword: "type", params: { type: schema166.properties.joined_at.type }, message: "must be string,null" }];
                    return false;
                  }
                  var valid0 = _errs9 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.mode !== void 0) {
                    let data5 = data.mode;
                    const _errs11 = errors;
                    if (typeof data5 !== "string") {
                      validate114.errors = [{ instancePath: instancePath + "/mode", schemaPath: "#/$defs/VoiceMode/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                    if (!(data5 === "joined" || data5 === "listen")) {
                      validate114.errors = [{ instancePath: instancePath + "/mode", schemaPath: "#/$defs/VoiceMode/enum", keyword: "enum", params: { allowedValues: schema167.enum }, message: "must be equal to one of the allowed values" }];
                      return false;
                    }
                    var valid0 = _errs11 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.mute !== void 0) {
                      const _errs14 = errors;
                      if (typeof data.mute !== "boolean") {
                        validate114.errors = [{ instancePath: instancePath + "/mute", schemaPath: "#/properties/mute/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                        return false;
                      }
                      var valid0 = _errs14 === errors;
                    } else {
                      var valid0 = true;
                    }
                    if (valid0) {
                      if (data.request_to_speak_at !== void 0) {
                        let data7 = data.request_to_speak_at;
                        const _errs16 = errors;
                        if (typeof data7 !== "string" && data7 !== null) {
                          validate114.errors = [{ instancePath: instancePath + "/request_to_speak_at", schemaPath: "#/properties/request_to_speak_at/type", keyword: "type", params: { type: schema166.properties.request_to_speak_at.type }, message: "must be string,null" }];
                          return false;
                        }
                        var valid0 = _errs16 === errors;
                      } else {
                        var valid0 = true;
                      }
                      if (valid0) {
                        if (data.self_deaf !== void 0) {
                          const _errs18 = errors;
                          if (typeof data.self_deaf !== "boolean") {
                            validate114.errors = [{ instancePath: instancePath + "/self_deaf", schemaPath: "#/properties/self_deaf/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                            return false;
                          }
                          var valid0 = _errs18 === errors;
                        } else {
                          var valid0 = true;
                        }
                        if (valid0) {
                          if (data.self_mute !== void 0) {
                            const _errs20 = errors;
                            if (typeof data.self_mute !== "boolean") {
                              validate114.errors = [{ instancePath: instancePath + "/self_mute", schemaPath: "#/properties/self_mute/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                              return false;
                            }
                            var valid0 = _errs20 === errors;
                          } else {
                            var valid0 = true;
                          }
                          if (valid0) {
                            if (data.self_stream !== void 0) {
                              const _errs22 = errors;
                              if (typeof data.self_stream !== "boolean") {
                                validate114.errors = [{ instancePath: instancePath + "/self_stream", schemaPath: "#/properties/self_stream/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                                return false;
                              }
                              var valid0 = _errs22 === errors;
                            } else {
                              var valid0 = true;
                            }
                            if (valid0) {
                              if (data.self_stream_started_at !== void 0) {
                                let data11 = data.self_stream_started_at;
                                const _errs24 = errors;
                                if (typeof data11 !== "string" && data11 !== null) {
                                  validate114.errors = [{ instancePath: instancePath + "/self_stream_started_at", schemaPath: "#/properties/self_stream_started_at/type", keyword: "type", params: { type: schema166.properties.self_stream_started_at.type }, message: "must be string,null" }];
                                  return false;
                                }
                                var valid0 = _errs24 === errors;
                              } else {
                                var valid0 = true;
                              }
                              if (valid0) {
                                if (data.self_video !== void 0) {
                                  const _errs26 = errors;
                                  if (typeof data.self_video !== "boolean") {
                                    validate114.errors = [{ instancePath: instancePath + "/self_video", schemaPath: "#/properties/self_video/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                                    return false;
                                  }
                                  var valid0 = _errs26 === errors;
                                } else {
                                  var valid0 = true;
                                }
                                if (valid0) {
                                  if (data.session_id !== void 0) {
                                    let data13 = data.session_id;
                                    const _errs28 = errors;
                                    if (typeof data13 !== "string" && data13 !== null) {
                                      validate114.errors = [{ instancePath: instancePath + "/session_id", schemaPath: "#/properties/session_id/type", keyword: "type", params: { type: schema166.properties.session_id.type }, message: "must be string,null" }];
                                      return false;
                                    }
                                    var valid0 = _errs28 === errors;
                                  } else {
                                    var valid0 = true;
                                  }
                                  if (valid0) {
                                    if (data.speaking !== void 0) {
                                      let data14 = data.speaking;
                                      const _errs30 = errors;
                                      if (typeof data14 !== "boolean" && data14 !== null) {
                                        validate114.errors = [{ instancePath: instancePath + "/speaking", schemaPath: "#/properties/speaking/type", keyword: "type", params: { type: schema166.properties.speaking.type }, message: "must be boolean,null" }];
                                        return false;
                                      }
                                      var valid0 = _errs30 === errors;
                                    } else {
                                      var valid0 = true;
                                    }
                                    if (valid0) {
                                      if (data.suppress !== void 0) {
                                        const _errs32 = errors;
                                        if (typeof data.suppress !== "boolean") {
                                          validate114.errors = [{ instancePath: instancePath + "/suppress", schemaPath: "#/properties/suppress/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                                          return false;
                                        }
                                        var valid0 = _errs32 === errors;
                                      } else {
                                        var valid0 = true;
                                      }
                                      if (valid0) {
                                        if (data.user_id !== void 0) {
                                          let data16 = data.user_id;
                                          const _errs34 = errors;
                                          if (errors === _errs34) {
                                            if (typeof data16 === "string") {
                                              if (func1(data16) < 1) {
                                                validate114.errors = [{ instancePath: instancePath + "/user_id", schemaPath: "#/properties/user_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                                                return false;
                                              } else {
                                                if (!pattern4.test(data16)) {
                                                  validate114.errors = [{ instancePath: instancePath + "/user_id", schemaPath: "#/properties/user_id/pattern", keyword: "pattern", params: { pattern: "^[0-9]+$" }, message: 'must match pattern "^[0-9]+$"' }];
                                                  return false;
                                                }
                                              }
                                            } else {
                                              validate114.errors = [{ instancePath: instancePath + "/user_id", schemaPath: "#/properties/user_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                              return false;
                                            }
                                          }
                                          var valid0 = _errs34 === errors;
                                        } else {
                                          var valid0 = true;
                                        }
                                        if (valid0) {
                                          if (data.username !== void 0) {
                                            let data17 = data.username;
                                            const _errs36 = errors;
                                            if (typeof data17 !== "string" && data17 !== null) {
                                              validate114.errors = [{ instancePath: instancePath + "/username", schemaPath: "#/properties/username/type", keyword: "type", params: { type: schema166.properties.username.type }, message: "must be string,null" }];
                                              return false;
                                            }
                                            var valid0 = _errs36 === errors;
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
      validate114.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate114.errors = vErrors;
  return errors === 0;
}
validate114.evaluated = { "props": { "avatar_hash": true, "channel_id": true, "deaf": true, "guild_id": true, "joined_at": true, "mode": true, "mute": true, "request_to_speak_at": true, "self_deaf": true, "self_mute": true, "self_stream": true, "self_stream_started_at": true, "self_video": true, "session_id": true, "speaking": true, "suppress": true, "user_id": true, "username": true }, "dynamicProps": false, "dynamicItems": false };
var isVoiceViewSession = validate115;
var schema168 = { "$defs": { "VoiceViewKind": { "description": "What a view session receives.\n\n- `watch`: the chosen stream's video and its own audio (never the voices).\n  Counted in the channel's watcher counts, so others see \"2 watching\".\n- `ambient`: the stream's lowest simulcast layer, keyframes only, at most\n  one frame a second, video only. Not counted and not shown to anybody.", "enum": ["watch", "ambient"], "type": "string" }, "VoiceViewMedia": { "description": "How to connect a view session's media (the same native endpoint a call\nuses; the token admits only this view).", "properties": { "cert_hash": { "type": ["string", "null"] }, "media_endpoint": { "minLength": 1, "type": "string" }, "media_endpoint_candidates": { "items": { "type": "string" }, "type": "array" }, "media_token": { "minLength": 1, "type": "string" }, "room_name": { "minLength": 1, "type": "string" } }, "required": ["media_endpoint", "media_endpoint_candidates", "media_token", "cert_hash", "room_name"], "type": "object" } }, "$id": "urn:paracord:contract:VoiceViewSession", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "Response of `POST /api/v2/voice/{channel_id}/view`.\n\nWhen the caller is already in this channel's call (joined or listening),\nthe view rides that call: `via_membership` is true, `session_id` and\n`media` are null, and the caller subscribes to the stream through its call\nconnection. Otherwise it is a separate view session with its own receipt\nand media credentials; an account holds one at a time, and a new one\nreplaces the old (whose connection the relay closes).", "properties": { "channel_id": { "minLength": 1, "pattern": "^[0-9]+$", "type": "string" }, "guild_id": { "description": "Null for a DM or group DM call.", "minLength": 1, "pattern": "^[0-9]+$", "type": ["string", "null"] }, "kind": { "$ref": "#/$defs/VoiceViewKind" }, "media": { "anyOf": [{ "$ref": "#/$defs/VoiceViewMedia" }, { "type": "null" }] }, "session_id": { "type": ["string", "null"] }, "user_id": { "description": "The streamer being viewed.", "minLength": 1, "pattern": "^[0-9]+$", "type": "string" }, "via_membership": { "type": "boolean" } }, "required": ["guild_id", "channel_id", "kind", "user_id", "via_membership", "session_id", "media"], "title": "VoiceViewSession", "type": "object" };
var schema169 = { "description": "What a view session receives.\n\n- `watch`: the chosen stream's video and its own audio (never the voices).\n  Counted in the channel's watcher counts, so others see \"2 watching\".\n- `ambient`: the stream's lowest simulcast layer, keyframes only, at most\n  one frame a second, video only. Not counted and not shown to anybody.", "enum": ["watch", "ambient"], "type": "string" };
var schema170 = { "description": "How to connect a view session's media (the same native endpoint a call\nuses; the token admits only this view).", "properties": { "cert_hash": { "type": ["string", "null"] }, "media_endpoint": { "minLength": 1, "type": "string" }, "media_endpoint_candidates": { "items": { "type": "string" }, "type": "array" }, "media_token": { "minLength": 1, "type": "string" }, "room_name": { "minLength": 1, "type": "string" } }, "required": ["media_endpoint", "media_endpoint_candidates", "media_token", "cert_hash", "room_name"], "type": "object" };
function validate115(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate115.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.guild_id === void 0 && (missing0 = "guild_id") || data.channel_id === void 0 && (missing0 = "channel_id") || data.kind === void 0 && (missing0 = "kind") || data.user_id === void 0 && (missing0 = "user_id") || data.via_membership === void 0 && (missing0 = "via_membership") || data.session_id === void 0 && (missing0 = "session_id") || data.media === void 0 && (missing0 = "media")) {
        validate115.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.channel_id !== void 0) {
          let data0 = data.channel_id;
          const _errs1 = errors;
          if (errors === _errs1) {
            if (typeof data0 === "string") {
              if (func1(data0) < 1) {
                validate115.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                return false;
              } else {
                if (!pattern4.test(data0)) {
                  validate115.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/pattern", keyword: "pattern", params: { pattern: "^[0-9]+$" }, message: 'must match pattern "^[0-9]+$"' }];
                  return false;
                }
              }
            } else {
              validate115.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.guild_id !== void 0) {
            let data1 = data.guild_id;
            const _errs3 = errors;
            if (typeof data1 !== "string" && data1 !== null) {
              validate115.errors = [{ instancePath: instancePath + "/guild_id", schemaPath: "#/properties/guild_id/type", keyword: "type", params: { type: schema168.properties.guild_id.type }, message: "must be string,null" }];
              return false;
            }
            if (errors === _errs3) {
              if (typeof data1 === "string") {
                if (func1(data1) < 1) {
                  validate115.errors = [{ instancePath: instancePath + "/guild_id", schemaPath: "#/properties/guild_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                } else {
                  if (!pattern4.test(data1)) {
                    validate115.errors = [{ instancePath: instancePath + "/guild_id", schemaPath: "#/properties/guild_id/pattern", keyword: "pattern", params: { pattern: "^[0-9]+$" }, message: 'must match pattern "^[0-9]+$"' }];
                    return false;
                  }
                }
              }
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.kind !== void 0) {
              let data2 = data.kind;
              const _errs5 = errors;
              if (typeof data2 !== "string") {
                validate115.errors = [{ instancePath: instancePath + "/kind", schemaPath: "#/$defs/VoiceViewKind/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
              if (!(data2 === "watch" || data2 === "ambient")) {
                validate115.errors = [{ instancePath: instancePath + "/kind", schemaPath: "#/$defs/VoiceViewKind/enum", keyword: "enum", params: { allowedValues: schema169.enum }, message: "must be equal to one of the allowed values" }];
                return false;
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.media !== void 0) {
                let data3 = data.media;
                const _errs8 = errors;
                const _errs9 = errors;
                let valid2 = false;
                const _errs10 = errors;
                const _errs11 = errors;
                if (errors === _errs11) {
                  if (data3 && typeof data3 == "object" && !Array.isArray(data3)) {
                    let missing1;
                    if (data3.media_endpoint === void 0 && (missing1 = "media_endpoint") || data3.media_endpoint_candidates === void 0 && (missing1 = "media_endpoint_candidates") || data3.media_token === void 0 && (missing1 = "media_token") || data3.cert_hash === void 0 && (missing1 = "cert_hash") || data3.room_name === void 0 && (missing1 = "room_name")) {
                      const err0 = { instancePath: instancePath + "/media", schemaPath: "#/$defs/VoiceViewMedia/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" };
                      if (vErrors === null) {
                        vErrors = [err0];
                      } else {
                        vErrors.push(err0);
                      }
                      errors++;
                    } else {
                      if (data3.cert_hash !== void 0) {
                        let data4 = data3.cert_hash;
                        const _errs13 = errors;
                        if (typeof data4 !== "string" && data4 !== null) {
                          const err1 = { instancePath: instancePath + "/media/cert_hash", schemaPath: "#/$defs/VoiceViewMedia/properties/cert_hash/type", keyword: "type", params: { type: schema170.properties.cert_hash.type }, message: "must be string,null" };
                          if (vErrors === null) {
                            vErrors = [err1];
                          } else {
                            vErrors.push(err1);
                          }
                          errors++;
                        }
                        var valid4 = _errs13 === errors;
                      } else {
                        var valid4 = true;
                      }
                      if (valid4) {
                        if (data3.media_endpoint !== void 0) {
                          let data5 = data3.media_endpoint;
                          const _errs15 = errors;
                          if (errors === _errs15) {
                            if (typeof data5 === "string") {
                              if (func1(data5) < 1) {
                                const err2 = { instancePath: instancePath + "/media/media_endpoint", schemaPath: "#/$defs/VoiceViewMedia/properties/media_endpoint/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                                if (vErrors === null) {
                                  vErrors = [err2];
                                } else {
                                  vErrors.push(err2);
                                }
                                errors++;
                              }
                            } else {
                              const err3 = { instancePath: instancePath + "/media/media_endpoint", schemaPath: "#/$defs/VoiceViewMedia/properties/media_endpoint/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                              if (vErrors === null) {
                                vErrors = [err3];
                              } else {
                                vErrors.push(err3);
                              }
                              errors++;
                            }
                          }
                          var valid4 = _errs15 === errors;
                        } else {
                          var valid4 = true;
                        }
                        if (valid4) {
                          if (data3.media_endpoint_candidates !== void 0) {
                            let data6 = data3.media_endpoint_candidates;
                            const _errs17 = errors;
                            if (errors === _errs17) {
                              if (Array.isArray(data6)) {
                                var valid5 = true;
                                const len0 = data6.length;
                                for (let i0 = 0; i0 < len0; i0++) {
                                  const _errs19 = errors;
                                  if (typeof data6[i0] !== "string") {
                                    const err4 = { instancePath: instancePath + "/media/media_endpoint_candidates/" + i0, schemaPath: "#/$defs/VoiceViewMedia/properties/media_endpoint_candidates/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                    if (vErrors === null) {
                                      vErrors = [err4];
                                    } else {
                                      vErrors.push(err4);
                                    }
                                    errors++;
                                  }
                                  var valid5 = _errs19 === errors;
                                  if (!valid5) {
                                    break;
                                  }
                                }
                              } else {
                                const err5 = { instancePath: instancePath + "/media/media_endpoint_candidates", schemaPath: "#/$defs/VoiceViewMedia/properties/media_endpoint_candidates/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                                if (vErrors === null) {
                                  vErrors = [err5];
                                } else {
                                  vErrors.push(err5);
                                }
                                errors++;
                              }
                            }
                            var valid4 = _errs17 === errors;
                          } else {
                            var valid4 = true;
                          }
                          if (valid4) {
                            if (data3.media_token !== void 0) {
                              let data8 = data3.media_token;
                              const _errs21 = errors;
                              if (errors === _errs21) {
                                if (typeof data8 === "string") {
                                  if (func1(data8) < 1) {
                                    const err6 = { instancePath: instancePath + "/media/media_token", schemaPath: "#/$defs/VoiceViewMedia/properties/media_token/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                                    if (vErrors === null) {
                                      vErrors = [err6];
                                    } else {
                                      vErrors.push(err6);
                                    }
                                    errors++;
                                  }
                                } else {
                                  const err7 = { instancePath: instancePath + "/media/media_token", schemaPath: "#/$defs/VoiceViewMedia/properties/media_token/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                  if (vErrors === null) {
                                    vErrors = [err7];
                                  } else {
                                    vErrors.push(err7);
                                  }
                                  errors++;
                                }
                              }
                              var valid4 = _errs21 === errors;
                            } else {
                              var valid4 = true;
                            }
                            if (valid4) {
                              if (data3.room_name !== void 0) {
                                let data9 = data3.room_name;
                                const _errs23 = errors;
                                if (errors === _errs23) {
                                  if (typeof data9 === "string") {
                                    if (func1(data9) < 1) {
                                      const err8 = { instancePath: instancePath + "/media/room_name", schemaPath: "#/$defs/VoiceViewMedia/properties/room_name/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                                      if (vErrors === null) {
                                        vErrors = [err8];
                                      } else {
                                        vErrors.push(err8);
                                      }
                                      errors++;
                                    }
                                  } else {
                                    const err9 = { instancePath: instancePath + "/media/room_name", schemaPath: "#/$defs/VoiceViewMedia/properties/room_name/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                                    if (vErrors === null) {
                                      vErrors = [err9];
                                    } else {
                                      vErrors.push(err9);
                                    }
                                    errors++;
                                  }
                                }
                                var valid4 = _errs23 === errors;
                              } else {
                                var valid4 = true;
                              }
                            }
                          }
                        }
                      }
                    }
                  } else {
                    const err10 = { instancePath: instancePath + "/media", schemaPath: "#/$defs/VoiceViewMedia/type", keyword: "type", params: { type: "object" }, message: "must be object" };
                    if (vErrors === null) {
                      vErrors = [err10];
                    } else {
                      vErrors.push(err10);
                    }
                    errors++;
                  }
                }
                var _valid0 = _errs10 === errors;
                valid2 = valid2 || _valid0;
                if (_valid0) {
                  var props0 = {};
                  props0.cert_hash = true;
                  props0.media_endpoint = true;
                  props0.media_endpoint_candidates = true;
                  props0.media_token = true;
                  props0.room_name = true;
                }
                const _errs25 = errors;
                if (data3 !== null) {
                  const err11 = { instancePath: instancePath + "/media", schemaPath: "#/properties/media/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                  if (vErrors === null) {
                    vErrors = [err11];
                  } else {
                    vErrors.push(err11);
                  }
                  errors++;
                }
                var _valid0 = _errs25 === errors;
                valid2 = valid2 || _valid0;
                if (!valid2) {
                  const err12 = { instancePath: instancePath + "/media", schemaPath: "#/properties/media/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                  if (vErrors === null) {
                    vErrors = [err12];
                  } else {
                    vErrors.push(err12);
                  }
                  errors++;
                  validate115.errors = vErrors;
                  return false;
                } else {
                  errors = _errs9;
                  if (vErrors !== null) {
                    if (_errs9) {
                      vErrors.length = _errs9;
                    } else {
                      vErrors = null;
                    }
                  }
                }
                var valid0 = _errs8 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.session_id !== void 0) {
                  let data10 = data.session_id;
                  const _errs27 = errors;
                  if (typeof data10 !== "string" && data10 !== null) {
                    validate115.errors = [{ instancePath: instancePath + "/session_id", schemaPath: "#/properties/session_id/type", keyword: "type", params: { type: schema168.properties.session_id.type }, message: "must be string,null" }];
                    return false;
                  }
                  var valid0 = _errs27 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.user_id !== void 0) {
                    let data11 = data.user_id;
                    const _errs29 = errors;
                    if (errors === _errs29) {
                      if (typeof data11 === "string") {
                        if (func1(data11) < 1) {
                          validate115.errors = [{ instancePath: instancePath + "/user_id", schemaPath: "#/properties/user_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                          return false;
                        } else {
                          if (!pattern4.test(data11)) {
                            validate115.errors = [{ instancePath: instancePath + "/user_id", schemaPath: "#/properties/user_id/pattern", keyword: "pattern", params: { pattern: "^[0-9]+$" }, message: 'must match pattern "^[0-9]+$"' }];
                            return false;
                          }
                        }
                      } else {
                        validate115.errors = [{ instancePath: instancePath + "/user_id", schemaPath: "#/properties/user_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                        return false;
                      }
                    }
                    var valid0 = _errs29 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.via_membership !== void 0) {
                      const _errs31 = errors;
                      if (typeof data.via_membership !== "boolean") {
                        validate115.errors = [{ instancePath: instancePath + "/via_membership", schemaPath: "#/properties/via_membership/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                        return false;
                      }
                      var valid0 = _errs31 === errors;
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
      validate115.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate115.errors = vErrors;
  return errors === 0;
}
validate115.evaluated = { "props": { "channel_id": true, "guild_id": true, "kind": true, "media": true, "session_id": true, "user_id": true, "via_membership": true }, "dynamicProps": false, "dynamicItems": false };
var isVoiceWatchers = validate116;
var schema171 = { "$defs": { "VoiceStreamWatchers": { "description": "One stream's watcher count.", "properties": { "user_id": { "description": "The streamer.", "minLength": 1, "pattern": "^[0-9]+$", "type": "string" }, "watchers": { "format": "uint32", "maximum": 4294967295, "minimum": 1, "type": "integer" } }, "required": ["user_id", "watchers"], "type": "object" } }, "$id": "urn:paracord:contract:VoiceWatchers", "$schema": "https://json-schema.org/draft/2020-12/schema", "description": "Watcher counts for one voice channel: `GET\n/api/v2/voice/{channel_id}/watchers` and the `VOICE_WATCHERS_UPDATE`\ngateway event. A complete snapshot for the channel: a stream that is not\nlisted has no watchers.", "properties": { "channel_id": { "minLength": 1, "pattern": "^[0-9]+$", "type": "string" }, "guild_id": { "description": "Null for a DM or group DM call (sent to its recipients only).", "minLength": 1, "pattern": "^[0-9]+$", "type": ["string", "null"] }, "streams": { "items": { "$ref": "#/$defs/VoiceStreamWatchers" }, "type": "array" } }, "required": ["guild_id", "channel_id", "streams"], "title": "VoiceWatchers", "type": "object" };
function validate116(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate116.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.guild_id === void 0 && (missing0 = "guild_id") || data.channel_id === void 0 && (missing0 = "channel_id") || data.streams === void 0 && (missing0 = "streams")) {
        validate116.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        if (data.channel_id !== void 0) {
          let data0 = data.channel_id;
          const _errs1 = errors;
          if (errors === _errs1) {
            if (typeof data0 === "string") {
              if (func1(data0) < 1) {
                validate116.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                return false;
              } else {
                if (!pattern4.test(data0)) {
                  validate116.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/pattern", keyword: "pattern", params: { pattern: "^[0-9]+$" }, message: 'must match pattern "^[0-9]+$"' }];
                  return false;
                }
              }
            } else {
              validate116.errors = [{ instancePath: instancePath + "/channel_id", schemaPath: "#/properties/channel_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
          }
          var valid0 = _errs1 === errors;
        } else {
          var valid0 = true;
        }
        if (valid0) {
          if (data.guild_id !== void 0) {
            let data1 = data.guild_id;
            const _errs3 = errors;
            if (typeof data1 !== "string" && data1 !== null) {
              validate116.errors = [{ instancePath: instancePath + "/guild_id", schemaPath: "#/properties/guild_id/type", keyword: "type", params: { type: schema171.properties.guild_id.type }, message: "must be string,null" }];
              return false;
            }
            if (errors === _errs3) {
              if (typeof data1 === "string") {
                if (func1(data1) < 1) {
                  validate116.errors = [{ instancePath: instancePath + "/guild_id", schemaPath: "#/properties/guild_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                } else {
                  if (!pattern4.test(data1)) {
                    validate116.errors = [{ instancePath: instancePath + "/guild_id", schemaPath: "#/properties/guild_id/pattern", keyword: "pattern", params: { pattern: "^[0-9]+$" }, message: 'must match pattern "^[0-9]+$"' }];
                    return false;
                  }
                }
              }
            }
            var valid0 = _errs3 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.streams !== void 0) {
              let data2 = data.streams;
              const _errs5 = errors;
              if (errors === _errs5) {
                if (Array.isArray(data2)) {
                  var valid1 = true;
                  const len0 = data2.length;
                  for (let i0 = 0; i0 < len0; i0++) {
                    let data3 = data2[i0];
                    const _errs7 = errors;
                    const _errs8 = errors;
                    if (errors === _errs8) {
                      if (data3 && typeof data3 == "object" && !Array.isArray(data3)) {
                        let missing1;
                        if (data3.user_id === void 0 && (missing1 = "user_id") || data3.watchers === void 0 && (missing1 = "watchers")) {
                          validate116.errors = [{ instancePath: instancePath + "/streams/" + i0, schemaPath: "#/$defs/VoiceStreamWatchers/required", keyword: "required", params: { missingProperty: missing1 }, message: "must have required property '" + missing1 + "'" }];
                          return false;
                        } else {
                          if (data3.user_id !== void 0) {
                            let data4 = data3.user_id;
                            const _errs10 = errors;
                            if (errors === _errs10) {
                              if (typeof data4 === "string") {
                                if (func1(data4) < 1) {
                                  validate116.errors = [{ instancePath: instancePath + "/streams/" + i0 + "/user_id", schemaPath: "#/$defs/VoiceStreamWatchers/properties/user_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                                  return false;
                                } else {
                                  if (!pattern4.test(data4)) {
                                    validate116.errors = [{ instancePath: instancePath + "/streams/" + i0 + "/user_id", schemaPath: "#/$defs/VoiceStreamWatchers/properties/user_id/pattern", keyword: "pattern", params: { pattern: "^[0-9]+$" }, message: 'must match pattern "^[0-9]+$"' }];
                                    return false;
                                  }
                                }
                              } else {
                                validate116.errors = [{ instancePath: instancePath + "/streams/" + i0 + "/user_id", schemaPath: "#/$defs/VoiceStreamWatchers/properties/user_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                return false;
                              }
                            }
                            var valid3 = _errs10 === errors;
                          } else {
                            var valid3 = true;
                          }
                          if (valid3) {
                            if (data3.watchers !== void 0) {
                              let data5 = data3.watchers;
                              const _errs12 = errors;
                              if (!(typeof data5 == "number" && (!(data5 % 1) && !isNaN(data5)) && isFinite(data5))) {
                                validate116.errors = [{ instancePath: instancePath + "/streams/" + i0 + "/watchers", schemaPath: "#/$defs/VoiceStreamWatchers/properties/watchers/type", keyword: "type", params: { type: "integer" }, message: "must be integer" }];
                                return false;
                              }
                              if (errors === _errs12) {
                                if (typeof data5 == "number" && isFinite(data5)) {
                                  if (data5 > 4294967295 || isNaN(data5)) {
                                    validate116.errors = [{ instancePath: instancePath + "/streams/" + i0 + "/watchers", schemaPath: "#/$defs/VoiceStreamWatchers/properties/watchers/maximum", keyword: "maximum", params: { comparison: "<=", limit: 4294967295 }, message: "must be <= 4294967295" }];
                                    return false;
                                  } else {
                                    if (data5 < 1 || isNaN(data5)) {
                                      validate116.errors = [{ instancePath: instancePath + "/streams/" + i0 + "/watchers", schemaPath: "#/$defs/VoiceStreamWatchers/properties/watchers/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" }];
                                      return false;
                                    }
                                  }
                                }
                              }
                              var valid3 = _errs12 === errors;
                            } else {
                              var valid3 = true;
                            }
                          }
                        }
                      } else {
                        validate116.errors = [{ instancePath: instancePath + "/streams/" + i0, schemaPath: "#/$defs/VoiceStreamWatchers/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                        return false;
                      }
                    }
                    var valid1 = _errs7 === errors;
                    if (!valid1) {
                      break;
                    }
                  }
                } else {
                  validate116.errors = [{ instancePath: instancePath + "/streams", schemaPath: "#/properties/streams/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
                  return false;
                }
              }
              var valid0 = _errs5 === errors;
            } else {
              var valid0 = true;
            }
          }
        }
      }
    } else {
      validate116.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate116.errors = vErrors;
  return errors === 0;
}
validate116.evaluated = { "props": { "channel_id": true, "guild_id": true, "streams": true }, "dynamicProps": false, "dynamicItems": false };
export {
  isAcceptInviteRequest,
  isBackupNowResponse,
  isChangeCredentialRequest,
  isChangeEmailRequest,
  isChangePasswordRequest,
  isChannelPreview,
  isChannelPreviewList,
  isCreateGuildRequest,
  isCreateInviteRequest,
  isCreateRelationshipRequest,
  isCredentialClaimRequest,
  isCredentialEmailResetRequest,
  isCredentialEpochResponse,
  isCredentialLoginRequest,
  isCredentialParams,
  isCredentialParamsRequest,
  isCredentialRegister,
  isCredentialUpgradeRequest,
  isCurrentUser,
  isGuildDetail,
  isGuildEmoji,
  isGuildEmojiList,
  isGuildInvite,
  isGuildInviteList,
  isGuildSummary,
  isGuildSummaryList,
  isHostPreflight,
  isHostProgress,
  isHostStatus,
  isInstanceStatusUpdate,
  isInviteAcceptResponse,
  isInvitePreview,
  isKeyBackup,
  isNewOwnerClaim,
  isOwnershipTransferResponse,
  isPasswordRequirements,
  isPublicUserProfile,
  isReadyGuildCore,
  isRelationshipList,
  isResetCredentialRequest,
  isStartVoiceViewRequest,
  isStorageKeyEscrowRequest,
  isTransferOwnershipRequest,
  isUpdateBackupsRequest,
  isUpdateEmojiRequest,
  isUpdateGuildRequest,
  isUpdateMeRequest,
  isUpdateSettingsRequest,
  isUpdateVoiceModeRequest,
  isUpdatedCurrentUser,
  isUserSettingsResponse,
  isVoiceModeResponse,
  isVoiceStateSnapshot,
  isVoiceViewSession,
  isVoiceWatchers
};
