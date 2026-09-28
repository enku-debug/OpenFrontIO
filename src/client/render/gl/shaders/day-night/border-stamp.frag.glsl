#version 300 es
precision highp float;
precision highp usampler2D;

uniform usampler2D uTileTex;
uniform sampler2D uPalette;
uniform sampler2D uBorderTex;     // RGBA8 — border flags from BorderComputePass
uniform sampler2D uDefenseCoverageTex; // R8 — 1.0 = defended by same-owner post
uniform sampler2D uAffiliation;   // 256×2 RGBA8 — affiliation colors (row 0 = border)
uniform vec2 uMapSize;
uniform int uAltView;
uniform float uHighlightBrighten;
uniform float uDefenseCheckerDarken;
uniform float uEmbargoTintRatio;
uniform float uFriendlyTintRatio;
uniform vec3 uEmbargoTint;
uniform vec3 uFriendlyTint;
uniform int uSmooth;              // 1 = smooth, anti-aliased border edges

in vec2 vWorldPos;
out vec4 fragColor;

// What a tile looks like for edge smoothing: owner + fallout, and whether it
// is a border tile. MUST match tileKey() in territory.frag.glsl so fill and
// borders pick the same tile for every pixel.
uint tileKey(ivec2 tc) {
  uint raw = texelFetch(uTileTex, tc, 0).r;
  uint key = raw & (uint(OWNER_MASK) | (1u << FALLOUT_BIT));
  return (key << 1) | (texelFetch(uBorderTex, tc, 0).r > 0.25 ? 1u : 0u);
}

// Smooth tile edges: the four tiles around this pixel vote with bilinear
// weights, grouped by tileKey. Returns the nearest tile of the winning key
// and, via `second`, the nearest tile of the runner-up key (the winner again
// if all four agree). MUST match smoothTile() in territory.frag.glsl.
ivec2 smoothTile(vec2 p, out float margin, out ivec2 second) {
  vec2 q = p - 0.5;
  vec2 fl = floor(q);
  vec2 f = q - fl;
  ivec2 i0 = ivec2(fl);
  ivec2 hi = ivec2(uMapSize) - 1;
  ivec2 c[4];
  float w[4];
  uint k[4];
  for (int i = 0; i < 4; i++) {
    ivec2 o = ivec2(i & 1, i >> 1);
    c[i] = clamp(i0 + o, ivec2(0), hi);
    w[i] = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
    k[i] = tileKey(c[i]);
  }
  float s[4];
  for (int i = 0; i < 4; i++) {
    s[i] = 0.0;
    for (int j = 0; j < 4; j++) s[i] += k[j] == k[i] ? w[j] : 0.0;
  }
  int t = 0;
  for (int i = 1; i < 4; i++) {
    if (s[i] > s[t] || (k[i] == k[t] && w[i] > w[t])) t = i;
  }
  int u = -1;
  for (int i = 0; i < 4; i++) {
    if (k[i] != k[t] && (u < 0 || s[i] > s[u] || (k[i] == k[u] && w[i] > w[u]))) u = i;
  }
  second = u < 0 ? c[t] : c[u];
  margin = s[t] - (u < 0 ? 0.0 : s[u]);
  return c[t];
}

// Border color of tile `tc`, or alpha 0 if it isn't an owned border tile.
vec4 borderColor(ivec2 tc) {
  uint owner = texelFetch(uTileTex, tc, 0).r & uint(OWNER_MASK);

  // Read pre-computed border flags from BorderComputePass
  vec4 borderData = texelFetch(uBorderTex, tc, 0);
  float borderType = borderData.r;      // 0=interior, ~0.5=normal, ~1.0=highlight
  float relation = borderData.a;        // 0.0=neutral, ~0.5=friendly, ~1.0=embargo

  bool isBorder = borderType > 0.25;
  bool isHighlightBorder = borderType > 0.75;
  if (!isBorder || owner == 0u) return vec4(0.0);

  // --- Border stamp: full-brightness border color ---
  vec3 bc;
  if (uAltView != 0) {
    // Alt-view: pure affiliation color from palette row 0
    bc = texelFetch(uAffiliation, ivec2(int(owner), 0), 0).rgb;
  } else {
    float u = (float(owner) + 0.5) / float(PALETTE_SIZE);
    bc = textureLod(uPalette, vec2(u, 0.75), 0.0).rgb;
    if (isHighlightBorder) {
      bc = mix(bc, vec3(1.0), uHighlightBrighten);
    }
    // Relationship tint (applied BEFORE defense checkerboard, matching game)
    if (relation > 0.75) {
      bc = mix(bc, uEmbargoTint, uEmbargoTintRatio);
    } else if (relation > 0.25) {
      bc = mix(bc, uFriendlyTint, uFriendlyTintRatio);
    }
    // Defense bonus: checkerboard darken (applied AFTER tint, matching game)
    bool defense = texelFetch(uDefenseCoverageTex, tc, 0).r > 0.5; // same-owner defense post nearby
    if (defense) {
      bool checker = ((tc.x + tc.y) & 1) == 1;
      if (checker) bc *= uDefenseCheckerDarken;
    }
  }
  return vec4(bc, 1.0);
}

void main() {
  ivec2 tc = ivec2(floor(vWorldPos));
  if (tc.x < 0 || tc.y < 0 || tc.x >= int(uMapSize.x) || tc.y >= int(uMapSize.y)) discard;

  if (uSmooth == 0) {
    vec4 bc = borderColor(tc);
    if (bc.a == 0.0) discard;
    fragColor = bc;
    return;
  }

  // Smoothed: the winning tile's border, anti-aliased against whatever wins
  // on the other side of the edge (another border: blend the two colors;
  // fill or bare ground: fade out so it shows through).
  float margin;
  ivec2 other;
  ivec2 top = smoothTile(vWorldPos, margin, other);
  float cover = clamp(0.5 + margin / max(fwidth(margin), 1e-4), 0.5, 1.0);
  vec4 a = borderColor(top);
  vec4 b = borderColor(other);
  if (a.a > 0.0 && b.a > 0.0) {
    fragColor = vec4(mix(b.rgb, a.rgb, cover), 1.0);
  } else if (a.a > 0.0) {
    fragColor = vec4(a.rgb, cover);
  } else if (b.a > 0.0) {
    fragColor = vec4(b.rgb, 1.0 - cover);
  } else {
    discard;
  }
  if (fragColor.a <= 0.0) discard;
}
