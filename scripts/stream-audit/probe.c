// probe.c: an LD_PRELOAD for the desktop app under test (sender or viewer) that
// writes one line per pipeline event, stamped with CLOCK_MONOTONIC µs, to
// $SA_PROBE_LOG. It never changes what the app does; it only watches.
//
// Stages, in pipeline order (each line starts with its tag):
//   CAP   a captured screen frame handed to the app by PipeWire (scap's stream)
//   ESRC  a CPU frame entering the lavc filter graph (NVENC/VAAPI input)
//   EIN   a frame entering an encoder (lavc avcodec_send_frame / libvpx)
//   EOUT  an encoded packet leaving an encoder (size, keyframe flag)
//   ECFG  an encoder's configuration, once per encoder context
//   DIN   a packet entering a decoder; DOUT a decoded frame leaving it
//   UP    a decoded frame uploaded by the native underlay (glTexSubImage2D, I420)
//   SW    a window frame handed to the compositor (eglSwapBuffers*), with the
//         counter read back from the composited pixels
//
// The synthetic source (pattern.py) bakes a 16-bit code (12-bit frame counter +
// 4-bit check) into a band of full-width bars between 35% and 65% of the frame
// height: bar 0 red, bars 1..16 data (white = 1, black = 0, MSB first), bar 17
// blue. Every stage that sees CPU pixels reads that code back, so a frame can be
// followed from the source to the screen.
//
// SW reads one pixel column of the window's back buffer at x = the value in
// $SA_PROBE_CFG ("x=<physical px>", re-read when the file changes; x<0 turns it
// off) through a ring of pixel-pack buffers, so the readback never stalls the
// paint: the code of swap i is logged at swap i+2 with swap i's time.
//
// Build (stream-audit.sh does this):
//   gcc -shared -fPIC -O2 -o libsaprobe.so probe.c -ldl -lpthread $(pkg-config --cflags libpipewire-0.3 libavcodec)
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <libavcodec/avcodec.h>
#include <libavutil/frame.h>
#include <libavutil/pixfmt.h>
#include <pipewire/stream.h>
#include <spa/buffer/buffer.h>
#include <vpx/vpx_decoder.h>
#include <vpx/vpx_encoder.h>

typedef unsigned int EGLBoolean;
typedef void *EGLDisplay;
typedef void *EGLSurface;
typedef int EGLint;
typedef unsigned int GLenum;
typedef unsigned int GLuint;
typedef int GLint;
typedef int GLsizei;
typedef intptr_t GLsizeiptr;
typedef intptr_t GLintptr;
typedef unsigned int GLbitfield;

#define EGL_HEIGHT 0x3056
#define EGL_WIDTH 0x3057
#define GL_RED 0x1903
#define GL_RGBA 0x1908
#define GL_UNSIGNED_BYTE 0x1401
#define GL_PIXEL_PACK_BUFFER 0x88EB
#define GL_PIXEL_PACK_BUFFER_BINDING 0x88ED
#define GL_READ_FRAMEBUFFER 0x8CA8
#define GL_READ_FRAMEBUFFER_BINDING 0x8CAA
#define GL_PACK_ALIGNMENT 0x0D05
#define GL_STREAM_READ 0x88E1
#define GL_MAP_READ_BIT 0x0001

static int active;
static int log_fd = -1;
static void *(*real_dlsym)(void *, const char *);

static int64_t now_us(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

static void out(const char *fmt, ...) {
  if (log_fd < 0) return;
  char line[512];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(line, sizeof line - 1, fmt, ap);
  va_end(ap);
  if (n <= 0) return;
  if (n > (int)sizeof line - 2) n = sizeof line - 2;
  line[n++] = '\n';
  ssize_t w = write(log_fd, line, (size_t)n);
  (void)w;
}

static int probe_inited;
__attribute__((constructor)) static void probe_init(void) {
  if (probe_inited) return;
  probe_inited = 1;
  real_dlsym = dlvsym(RTLD_NEXT, "dlsym", "GLIBC_2.34");
  if (!real_dlsym) real_dlsym = dlvsym(RTLD_NEXT, "dlsym", "GLIBC_2.2.5");
  char exe[512] = {0};
  ssize_t n = readlink("/proc/self/exe", exe, sizeof exe - 1);
  if (n > 0) exe[n] = 0;
  active = strstr(exe, "paracord-desktop") != NULL;
  // WebKit's processes inherit the environment; they must not load the probe.
  if (active) unsetenv("LD_PRELOAD");
  const char *path = getenv("SA_PROBE_LOG");
  if (active && path) {
    log_fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644);
    out("PROBE start t=%lld pid=%d exe=%s", (long long)now_us(), getpid(), exe);
  }
}

// ── The band code ───────────────────────────────────────────────────────────
// Rows of bar k (0..17) in a frame of height h: band from 0.35h to 0.65h.
static int bar_row(int k, int h) { return (int)(h * (0.35 + 0.30 * (k + 0.5) / 18.0)); }

// Read the 16 data bars from a luma accessor at three columns, majority vote.
typedef int (*luma_fn)(const void *ctx, int x, int y);
static int read_code(luma_fn luma, const void *ctx, int w, int h) {
  if (w < 16 || h < 36) return -1;
  int code = 0;
  for (int k = 1; k <= 16; k++) {
    int y = bar_row(k, h), ones = 0;
    for (int c = 1; c <= 3; c++) ones += luma(ctx, w * c / 4, y) > 128;
    code = (code << 1) | (ones >= 2);
  }
  // Sanity: the sync bars must be dark-ish (red/blue luma is low) and not white.
  int y0 = bar_row(0, h), y17 = bar_row(17, h);
  if (luma(ctx, w / 2, y0) > 150 || luma(ctx, w / 2, y17) > 150) return -2;
  return code;
}

struct packed_ctx { const uint8_t *p; int stride; int bpp; int r, g, b; };
static int packed_luma(const void *c, int x, int y) {
  const struct packed_ctx *k = c;
  const uint8_t *px = k->p + (size_t)y * k->stride + (size_t)x * k->bpp;
  return (px[k->r] * 2 + px[k->g] * 5 + px[k->b]) / 8;
}
struct plane_ctx { const uint8_t *p; int stride; };
static int plane_luma(const void *c, int x, int y) {
  const struct plane_ctx *k = c;
  return k->p[(size_t)y * k->stride + x];
}

// ── PipeWire capture (sender): scap's stream is named "scap" ────────────────
static struct pw_stream *scap_stream;
static int64_t cap_n;

struct pw_stream *pw_stream_new(struct pw_core *core, const char *name, struct pw_properties *props) {
  static struct pw_stream *(*real)(struct pw_core *, const char *, struct pw_properties *);
  if (!real) real = real_dlsym(RTLD_NEXT, "pw_stream_new");
  struct pw_stream *s = real(core, name, props);
  if (active && name && strcmp(name, "scap") == 0) {
    scap_stream = s;
    out("CAPSTREAM t=%lld", (long long)now_us());
  }
  return s;
}

struct pw_buffer *pw_stream_dequeue_buffer(struct pw_stream *stream) {
  static struct pw_buffer *(*real)(struct pw_stream *);
  if (!real) real = real_dlsym(RTLD_NEXT, "pw_stream_dequeue_buffer");
  struct pw_buffer *b = real(stream);
  if (active && b && stream == scap_stream && b->buffer && b->buffer->n_datas > 0) {
    int64_t t = now_us();
    struct spa_data *d = &b->buffer->datas[0];
    int code = -3, w = 0, h = 0;
    if (d->data && d->chunk && d->chunk->stride > 0) {
      int stride = d->chunk->stride;
      w = stride / 4;
      h = (int)(d->chunk->size / (uint32_t)stride);
      // BGRx from pattern.py.
      struct packed_ctx k = {(const uint8_t *)d->data + d->chunk->offset, stride, 4, 2, 1, 0};
      if (h > 0) code = read_code(packed_luma, &k, w, h);
    }
    out("CAP t=%lld n=%lld w=%d h=%d code=%d", (long long)t, (long long)++cap_n, w, h, code);
  }
  return b;
}

// ── libavcodec / libavfilter ────────────────────────────────────────────────
static void log_frame_code(const char *tag, AVCodecContext *ctx, const AVFrame *f) {
  int code = -3;
  if (f->format == AV_PIX_FMT_BGRA || f->format == AV_PIX_FMT_BGR0) {
    struct packed_ctx k = {f->data[0], f->linesize[0], 4, 2, 1, 0};
    code = read_code(packed_luma, &k, f->width, f->height);
  } else if (f->format == AV_PIX_FMT_RGBA || f->format == AV_PIX_FMT_RGB0) {
    struct packed_ctx k = {f->data[0], f->linesize[0], 4, 0, 1, 2};
    code = read_code(packed_luma, &k, f->width, f->height);
  } else if (f->format == AV_PIX_FMT_YUV420P || f->format == AV_PIX_FMT_NV12) {
    struct plane_ctx k = {f->data[0], f->linesize[0]};
    code = read_code(plane_luma, &k, f->width, f->height);
  }
  out("%s t=%lld ctx=%p w=%d h=%d fmt=%d pts=%lld code=%d", tag, (long long)now_us(), (void *)ctx,
      f->width, f->height, f->format, (long long)f->pts, code);
}

int av_buffersrc_add_frame_flags(void *filter, AVFrame *frame, int flags) {
  static int (*real)(void *, AVFrame *, int);
  if (!real) real = real_dlsym(RTLD_NEXT, "av_buffersrc_add_frame_flags");
  if (active && frame) log_frame_code("ESRC", NULL, frame);
  return real(filter, frame, flags);
}

int av_buffersrc_add_frame(void *filter, AVFrame *frame) {
  static int (*real)(void *, AVFrame *);
  if (!real) real = real_dlsym(RTLD_NEXT, "av_buffersrc_add_frame");
  if (active && frame) log_frame_code("ESRC", NULL, frame);
  return real(filter, frame);
}

static pthread_mutex_t seen_lock = PTHREAD_MUTEX_INITIALIZER;
static void *seen[64];
static int seen_n;
static int first_time(void *ctx) {
  pthread_mutex_lock(&seen_lock);
  for (int i = 0; i < seen_n; i++)
    if (seen[i] == ctx) { pthread_mutex_unlock(&seen_lock); return 0; }
  if (seen_n < 64) seen[seen_n++] = ctx;
  else seen[(seen_n++) % 64] = ctx;
  pthread_mutex_unlock(&seen_lock);
  return 1;
}

// The encoder's own settings, once per context. Private options (preset, tune,
// rc, cq) are not read: av_opt_get on a just-opened NVENC context crashed the
// app once during a mid-stream reconfiguration; the encoder sets them in
// paracord-codec's lavc/encoder.rs, which the audit quotes instead.
static void log_av_config(AVCodecContext *ctx) {
  out("ECFG t=%lld ctx=%p codec=%s w=%d h=%d bitrate=%lld maxrate=%lld bufsize=%d gop=%d fps=%d/%d tb=%d/%d pixfmt=%d",
      (long long)now_us(), (void *)ctx, ctx->codec ? ctx->codec->name : "?", ctx->width, ctx->height,
      (long long)ctx->bit_rate, (long long)ctx->rc_max_rate, ctx->rc_buffer_size, ctx->gop_size,
      ctx->framerate.num, ctx->framerate.den, ctx->time_base.num, ctx->time_base.den, ctx->pix_fmt);
}

int avcodec_send_frame(AVCodecContext *ctx, const AVFrame *frame) {
  static int (*real)(AVCodecContext *, const AVFrame *);
  if (!real) real = real_dlsym(RTLD_NEXT, "avcodec_send_frame");
  if (active && ctx && frame) {
    if (first_time(ctx)) log_av_config(ctx);
    log_frame_code("EIN", ctx, frame);
  }
  int64_t t0 = now_us();
  int r = real(ctx, frame);
  if (active && ctx && frame) out("EINDONE t=%lld ctx=%p dur=%lld ret=%d", (long long)now_us(), (void *)ctx,
                                  (long long)(now_us() - t0), r);
  return r;
}

int avcodec_receive_packet(AVCodecContext *ctx, AVPacket *pkt) {
  static int (*real)(AVCodecContext *, AVPacket *);
  if (!real) real = real_dlsym(RTLD_NEXT, "avcodec_receive_packet");
  int r = real(ctx, pkt);
  if (active && r == 0 && pkt)
    out("EOUT t=%lld ctx=%p size=%d key=%d pts=%lld lib=lavc", (long long)now_us(), (void *)ctx, pkt->size,
        (pkt->flags & AV_PKT_FLAG_KEY) ? 1 : 0, (long long)pkt->pts);
  return r;
}

int avcodec_send_packet(AVCodecContext *ctx, const AVPacket *pkt) {
  static int (*real)(AVCodecContext *, const AVPacket *);
  if (!real) real = real_dlsym(RTLD_NEXT, "avcodec_send_packet");
  if (active && ctx && pkt) {
    if (first_time(ctx))
      out("DCFG t=%lld ctx=%p codec=%s hw=%d", (long long)now_us(), (void *)ctx,
          ctx->codec ? ctx->codec->name : "?", ctx->hw_device_ctx != NULL);
    out("DIN t=%lld ctx=%p size=%d key=%d lib=lavc", (long long)now_us(), (void *)ctx, pkt->size,
        (pkt->flags & AV_PKT_FLAG_KEY) ? 1 : 0);
  }
  return real(ctx, pkt);
}

int avcodec_receive_frame(AVCodecContext *ctx, AVFrame *frame) {
  static int (*real)(AVCodecContext *, AVFrame *);
  if (!real) real = real_dlsym(RTLD_NEXT, "avcodec_receive_frame");
  int r = real(ctx, frame);
  if (active && r == 0 && frame)
    out("DOUT t=%lld ctx=%p w=%d h=%d fmt=%d lib=lavc", (long long)now_us(), (void *)ctx, frame->width,
        frame->height, frame->format);
  return r;
}

// ── libvpx ───────────────────────────────────────────────────────────────────
vpx_codec_err_t vpx_codec_enc_init_ver(vpx_codec_ctx_t *ctx, vpx_codec_iface_t *iface, const vpx_codec_enc_cfg_t *cfg,
                                       vpx_codec_flags_t flags, int ver) {
  static vpx_codec_err_t (*real)(vpx_codec_ctx_t *, vpx_codec_iface_t *, const vpx_codec_enc_cfg_t *,
                                 vpx_codec_flags_t, int);
  if (!real) real = real_dlsym(RTLD_NEXT, "vpx_codec_enc_init_ver");
  if (active && cfg)
    out("ECFG t=%lld ctx=%p codec=libvpx w=%u h=%u bitrate=%u kbps kf_max=%u kf_min=%u tb=%d/%d threads=%u "
        "end_usage=%d lag=%u",
        (long long)now_us(), (void *)ctx, cfg->g_w, cfg->g_h, cfg->rc_target_bitrate, cfg->kf_max_dist,
        cfg->kf_min_dist, cfg->g_timebase.num, cfg->g_timebase.den, cfg->g_threads, cfg->rc_end_usage,
        cfg->g_lag_in_frames);
  return real(ctx, iface, cfg, flags, ver);
}

vpx_codec_err_t vpx_codec_enc_config_set(vpx_codec_ctx_t *ctx, const vpx_codec_enc_cfg_t *cfg) {
  static vpx_codec_err_t (*real)(vpx_codec_ctx_t *, const vpx_codec_enc_cfg_t *);
  if (!real) real = real_dlsym(RTLD_NEXT, "vpx_codec_enc_config_set");
  if (active && cfg)
    out("ECFGSET t=%lld ctx=%p w=%u h=%u bitrate=%u kbps", (long long)now_us(), (void *)ctx, cfg->g_w, cfg->g_h,
        cfg->rc_target_bitrate);
  return real(ctx, cfg);
}

vpx_codec_err_t vpx_codec_encode(vpx_codec_ctx_t *ctx, const vpx_image_t *img, vpx_codec_pts_t pts,
                                 unsigned long duration, vpx_enc_frame_flags_t flags, vpx_enc_deadline_t deadline) {
  static vpx_codec_err_t (*real)(vpx_codec_ctx_t *, const vpx_image_t *, vpx_codec_pts_t, unsigned long,
                                 vpx_enc_frame_flags_t, vpx_enc_deadline_t);
  if (!real) real = real_dlsym(RTLD_NEXT, "vpx_codec_encode");
  int64_t t0 = now_us();
  if (active && img) {
    struct plane_ctx k = {img->planes[0], img->stride[0]};
    int code = read_code(plane_luma, &k, (int)img->d_w, (int)img->d_h);
    out("EIN t=%lld ctx=%p w=%u h=%u fmt=vpx pts=%lld code=%d", (long long)t0, (void *)ctx, img->d_w, img->d_h,
        (long long)pts, code);
  }
  vpx_codec_err_t r = real(ctx, img, pts, duration, flags, deadline);
  if (active && img)
    out("EINDONE t=%lld ctx=%p dur=%lld ret=%d", (long long)now_us(), (void *)ctx, (long long)(now_us() - t0), r);
  return r;
}

const vpx_codec_cx_pkt_t *vpx_codec_get_cx_data(vpx_codec_ctx_t *ctx, vpx_codec_iter_t *iter) {
  static const vpx_codec_cx_pkt_t *(*real)(vpx_codec_ctx_t *, vpx_codec_iter_t *);
  if (!real) real = real_dlsym(RTLD_NEXT, "vpx_codec_get_cx_data");
  const vpx_codec_cx_pkt_t *p = real(ctx, iter);
  if (active && p && p->kind == VPX_CODEC_CX_FRAME_PKT)
    out("EOUT t=%lld ctx=%p size=%zu key=%d pts=%lld lib=vpx", (long long)now_us(), (void *)ctx, p->data.frame.sz,
        (p->data.frame.flags & VPX_FRAME_IS_KEY) ? 1 : 0, (long long)p->data.frame.pts);
  return p;
}

vpx_codec_err_t vpx_codec_decode(vpx_codec_ctx_t *ctx, const uint8_t *data, unsigned int size, void *priv,
                                 long deadline) {
  static vpx_codec_err_t (*real)(vpx_codec_ctx_t *, const uint8_t *, unsigned int, void *, long);
  if (!real) real = real_dlsym(RTLD_NEXT, "vpx_codec_decode");
  if (active && data) out("DIN t=%lld ctx=%p size=%u lib=vpx", (long long)now_us(), (void *)ctx, size);
  return real(ctx, data, size, priv, deadline);
}

vpx_image_t *vpx_codec_get_frame(vpx_codec_ctx_t *ctx, vpx_codec_iter_t *iter) {
  static vpx_image_t *(*real)(vpx_codec_ctx_t *, vpx_codec_iter_t *);
  if (!real) real = real_dlsym(RTLD_NEXT, "vpx_codec_get_frame");
  vpx_image_t *img = real(ctx, iter);
  if (active && img) {
    struct plane_ctx k = {img->planes[0], img->stride[0]};
    int code = read_code(plane_luma, &k, (int)img->d_w, (int)img->d_h);
    out("DOUT t=%lld ctx=%p w=%u h=%u lib=vpx code=%d", (long long)now_us(), (void *)ctx, img->d_w, img->d_h, code);
  }
  return img;
}

// ── GL: the underlay's I420 uploads (viewer) ─────────────────────────────────
typedef void (*tsi_fn)(GLenum, GLint, GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, const void *);
static tsi_fn real_tsi;
static int up_phase;
static int64_t up_t0;
static int up_w, up_h, up_code;
static int64_t up_n;

static void w_tex_sub_image(GLenum target, GLint level, GLint x, GLint y, GLsizei w, GLsizei h, GLenum format,
                            GLenum type, const void *pixels) {
  if (active && format == GL_RED && pixels) {
    if (up_phase == 0) {
      up_t0 = now_us();
      up_w = w;
      up_h = h;
      struct plane_ctx k = {pixels, w};
      up_code = read_code(plane_luma, &k, w, h);
    }
    real_tsi(target, level, x, y, w, h, format, type, pixels);
    if (++up_phase == 3) {
      up_phase = 0;
      int64_t t1 = now_us();
      out("UP t=%lld n=%lld w=%d h=%d code=%d dur=%lld", (long long)up_t0, (long long)++up_n, up_w, up_h, up_code,
          (long long)(t1 - up_t0));
    }
    return;
  }
  real_tsi(target, level, x, y, w, h, format, type, pixels);
}

// ── EGL: what the window hands the compositor ───────────────────────────────
typedef EGLBoolean (*swap_fn)(EGLDisplay, EGLSurface);
typedef EGLBoolean (*swapd_fn)(EGLDisplay, EGLSurface, const EGLint *, EGLint);
typedef void *(*gpa_fn)(const char *);
static swap_fn real_swap;
static swapd_fn real_swap_ext, real_swap_khr;
static gpa_fn real_gpa;

static struct {
  void (*GetIntegerv)(GLenum, GLint *);
  void (*BindFramebuffer)(GLenum, GLuint);
  void (*ReadPixels)(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void *);
  void (*GenBuffers)(GLsizei, GLuint *);
  void (*BindBuffer)(GLenum, GLuint);
  void (*BufferData)(GLenum, GLsizeiptr, const void *, GLenum);
  void *(*MapBufferRange)(GLenum, GLintptr, GLsizeiptr, GLbitfield);
  EGLBoolean (*UnmapBuffer)(GLenum);
  void (*PixelStorei)(GLenum, GLint);
  EGLBoolean (*QuerySurface)(EGLDisplay, EGLSurface, EGLint, EGLint *);
  int ok;
} gl;

#define RING 3
#define MAXH 4400
static GLuint pbo[RING];
static int pbo_h[RING], pbo_x[RING];
static int64_t pbo_t[RING];
static void *pbo_surf[RING];
static int64_t swap_n;
static int cfg_x = -1;
static struct timespec cfg_mtime;

static void read_cfg(void) {
  const char *p = getenv("SA_PROBE_CFG");
  struct stat st;
  if (!p || stat(p, &st) != 0) return;
  if (st.st_mtim.tv_sec == cfg_mtime.tv_sec && st.st_mtim.tv_nsec == cfg_mtime.tv_nsec) return;
  cfg_mtime = st.st_mtim;
  FILE *f = fopen(p, "r");
  if (!f) return;
  int x;
  if (fscanf(f, "x=%d", &x) == 1) {
    cfg_x = x;
    out("SWCFG t=%lld x=%d", (long long)now_us(), x);
  }
  fclose(f);
}

static void gl_load(void) {
  if (gl.ok) return;
  if (!real_gpa) real_gpa = (gpa_fn)real_dlsym(RTLD_DEFAULT, "eglGetProcAddress");
  if (!real_gpa) return;
#define L(f, n) gl.f = real_gpa(n)
  L(GetIntegerv, "glGetIntegerv");
  L(BindFramebuffer, "glBindFramebuffer");
  L(ReadPixels, "glReadPixels");
  L(GenBuffers, "glGenBuffers");
  L(BindBuffer, "glBindBuffer");
  L(BufferData, "glBufferData");
  L(MapBufferRange, "glMapBufferRange");
  L(UnmapBuffer, "glUnmapBuffer");
  L(PixelStorei, "glPixelStorei");
#undef L
  gl.QuerySurface = real_dlsym(RTLD_DEFAULT, "eglQuerySurface");
  gl.ok = gl.GetIntegerv && gl.BindFramebuffer && gl.ReadPixels && gl.GenBuffers && gl.BindBuffer &&
          gl.BufferData && gl.MapBufferRange && gl.UnmapBuffer && gl.PixelStorei && gl.QuerySurface;
  if (gl.ok) {
    gl.GenBuffers(RING, pbo);
    GLint prev = 0;
    gl.GetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING, &prev);
    for (int i = 0; i < RING; i++) {
      gl.BindBuffer(GL_PIXEL_PACK_BUFFER, pbo[i]);
      gl.BufferData(GL_PIXEL_PACK_BUFFER, MAXH * 4, NULL, GL_STREAM_READ);
    }
    gl.BindBuffer(GL_PIXEL_PACK_BUFFER, (GLuint)prev);
  }
  out("GLPROBE t=%lld ok=%d", (long long)now_us(), gl.ok);
}

// Decode the column (bottom-up RGBA rows) by its red and blue sync bars.
static int decode_column(const uint8_t *px, int h, int *top, int *bar) {
  // Top-down scan: y_img = h-1-row.
#define AT(yi) (px + (size_t)(h - 1 - (yi)) * 4)
  int red0 = -1, blue1 = -1;
  for (int y = 0; y < h; y++) {
    const uint8_t *p = AT(y);
    if (p[0] > 140 && p[1] < 90 && p[2] < 90) {
      if (y + 1 < h) {
        const uint8_t *q = AT(y + 1);
        if (q[0] > 140 && q[1] < 90 && q[2] < 90) { red0 = y; break; }
      }
    }
  }
  if (red0 < 0) return -10;
  for (int y = h - 1; y > red0; y--) {
    const uint8_t *p = AT(y);
    if (p[2] > 140 && p[0] < 90 && p[1] < 110) {
      if (y - 1 > red0) {
        const uint8_t *q = AT(y - 1);
        if (q[2] > 140 && q[0] < 90 && q[1] < 110) { blue1 = y; break; }
      }
    }
  }
  if (blue1 < 0) return -11;
  double bh = (blue1 - red0 + 1) / 18.0;
  *top = red0;
  *bar = (int)(bh * 10);
  if (bh < 1.5) return -12;
  int code = 0;
  for (int k = 1; k <= 16; k++) {
    int y = red0 + (int)((k + 0.5) * bh);
    int sum = 0, n = 0;
    for (int d = -1; d <= 1; d++) {
      int yy = y + d;
      if (bh < 4 && d != 0) continue;
      if (yy < 0 || yy >= h) continue;
      const uint8_t *p = AT(yy);
      sum += (p[0] * 2 + p[1] * 5 + p[2]) / 8;
      n++;
    }
    code = (code << 1) | (n && sum / n > 128);
  }
  return code;
#undef AT
}

static void probe_swap(EGLDisplay dpy, EGLSurface surf) {
  int64_t t = now_us();
  int64_t n = ++swap_n;
  read_cfg();
  int x = cfg_x;
  if (x < 0) {
    out("SW t=%lld n=%lld surf=%p code=-20", (long long)t, (long long)n, surf);
    return;
  }
  gl_load();
  if (!gl.ok) return;
  EGLint h = 0, w = 0;
  gl.QuerySurface(dpy, surf, EGL_HEIGHT, &h);
  gl.QuerySurface(dpy, surf, EGL_WIDTH, &w);
  if (h > MAXH) h = MAXH;
  GLint prev_read = 0, prev_pack = 0, prev_align = 4;
  gl.GetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prev_read);
  gl.GetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING, &prev_pack);
  gl.GetIntegerv(GL_PACK_ALIGNMENT, &prev_align);
  gl.BindFramebuffer(GL_READ_FRAMEBUFFER, 0);
  gl.PixelStorei(GL_PACK_ALIGNMENT, 4);
  int slot = (int)(n % RING);
  // Collect the slot written RING-1 swaps ago... it is this slot's previous use.
  if (n > RING && pbo_t[slot] > 0) {
    gl.BindBuffer(GL_PIXEL_PACK_BUFFER, pbo[slot]);
    const uint8_t *m = gl.MapBufferRange(GL_PIXEL_PACK_BUFFER, 0, (GLsizeiptr)pbo_h[slot] * 4, GL_MAP_READ_BIT);
    int top = -1, bar = -1, code = -13;
    if (m) {
      code = decode_column(m, pbo_h[slot], &top, &bar);
      gl.UnmapBuffer(GL_PIXEL_PACK_BUFFER);
    }
    out("SW t=%lld n=%lld surf=%p x=%d h=%d code=%d top=%d bar10=%d", (long long)pbo_t[slot],
        (long long)(n - RING), pbo_surf[slot], pbo_x[slot], pbo_h[slot], code, top, bar);
  }
  if (x < w) {
    gl.BindBuffer(GL_PIXEL_PACK_BUFFER, pbo[slot]);
    gl.ReadPixels(x, 0, 1, h, GL_RGBA, GL_UNSIGNED_BYTE, (void *)0);
    pbo_t[slot] = t;
    pbo_h[slot] = h;
    pbo_x[slot] = x;
    pbo_surf[slot] = surf;
  } else {
    pbo_t[slot] = 0;
  }
  gl.BindBuffer(GL_PIXEL_PACK_BUFFER, (GLuint)prev_pack);
  gl.BindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prev_read);
  gl.PixelStorei(GL_PACK_ALIGNMENT, prev_align);
}

static EGLBoolean w_swap(EGLDisplay d, EGLSurface s) {
  if (active) probe_swap(d, s);
  return real_swap(d, s);
}
static EGLBoolean w_swap_ext(EGLDisplay d, EGLSurface s, const EGLint *r, EGLint n) {
  if (active) probe_swap(d, s);
  return real_swap_ext(d, s, r, n);
}
static EGLBoolean w_swap_khr(EGLDisplay d, EGLSurface s, const EGLint *r, EGLint n) {
  if (active) probe_swap(d, s);
  return real_swap_khr(d, s, r, n);
}

EGLBoolean eglSwapBuffers(EGLDisplay d, EGLSurface s) {
  if (!real_swap) real_swap = (swap_fn)real_dlsym(RTLD_NEXT, "eglSwapBuffers");
  return w_swap(d, s);
}

static void *wrap(const char *name, void *realp) {
  if (!active || !realp || !name) return realp;
  if (strcmp(name, "eglSwapBuffers") == 0) { real_swap = realp; return (void *)w_swap; }
  if (strcmp(name, "eglSwapBuffersWithDamageEXT") == 0) { real_swap_ext = realp; return (void *)w_swap_ext; }
  if (strcmp(name, "eglSwapBuffersWithDamageKHR") == 0) { real_swap_khr = realp; return (void *)w_swap_khr; }
  if (strcmp(name, "glTexSubImage2D") == 0) { real_tsi = realp; return (void *)w_tex_sub_image; }
  return realp;
}

static void *w_gpa(const char *name) {
  void *p = real_gpa(name);
  return wrap(name, p);
}

void *eglGetProcAddress(const char *name) {
  if (!real_gpa) real_gpa = (gpa_fn)real_dlsym(RTLD_NEXT, "eglGetProcAddress");
  return w_gpa(name);
}

void *dlsym(void *handle, const char *name) {
  if (!real_dlsym) probe_init();
  void *p = real_dlsym(handle, name);
  if (!active) return p;
  if (strcmp(name, "eglGetProcAddress") == 0 && p) {
    real_gpa = p;
    return (void *)w_gpa;
  }
  return wrap(name, p);
}
