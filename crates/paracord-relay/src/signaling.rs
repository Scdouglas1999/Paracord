// Media signaling types — re-exported from the canonical paracord-models crate.
pub use paracord_models::gateway::{
    EncryptedSenderKey, MediaKeyAnnounce, MediaKeyDeliver, MediaSessionDesc, MediaSubscribe,
    PeerInfo, SpeakerInfo, SpeakerUpdate, OP_MEDIA_CONNECT, OP_MEDIA_KEY_ANNOUNCE,
    OP_MEDIA_KEY_DELIVER, OP_MEDIA_SESSION_DESC, OP_MEDIA_SPEAKER_UPDATE, OP_MEDIA_SUBSCRIBE,
};
