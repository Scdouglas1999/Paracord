// Relay probes shared by the scene drivers: the room as the relay sees it,
// leaving through the API, and the synthetic media a cast page is producing.

/** Read the relay's live view of the room (side-effect free). */
export async function readRoom(api, token, channelId) {
  return api.request(token, 'GET', `/voice/${channelId}/media-stats`);
}

/** Leave through the API as well as the UI, so the relay retires the seat now rather than on idle. */
export async function leaveCall(api, person, channelId) {
  await api.request(person.token, 'POST', `/api/v2/voice/${channelId}/leave`, {}).catch(() => {});
}

/** Frames each cast page has produced (display scene / camera) and the talker's level. */
export async function mediaProbe(member) {
  return member.session.page.evaluate(() => {
    const s = window.__glassSceneMedia;
    return s ? { displayFrames: s.displayFrames, cameraFrames: s.cameraFrames, voiceLevel: s.voiceLevel } : null;
  }).catch(() => null);
}
