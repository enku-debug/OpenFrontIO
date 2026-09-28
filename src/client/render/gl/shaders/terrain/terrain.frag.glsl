#version 300 es
precision highp float;
precision highp usampler2D;

uniform sampler2D uTerrain;       // RGBA8 — color per tile
uniform usampler2D uTerrainBytes; // R8UI — terrain byte per tile (bit7 land, bits 0-4 magnitude)
uniform int uSmooth;              // 1 = smooth coastlines + blended colors, 0 = square tiles

in vec2 vUV;
out vec4 fragColor;

// 0 = water, 1 = land, 2 = impassable (painted as the background).
int terrainClass(ivec2 tc) {
  uint b = texelFetch(uTerrainBytes, tc, 0).r;
  if ((b & 0x80u) == 0u) return 0;
  return (b & 0x1fu) == 31u ? 2 : 1;
}

void main() {
  if (uSmooth == 0) {
    fragColor = vec4(texture(uTerrain, vUV).rgb, 1.0);
    return;
  }

  // The four tile centers around this pixel vote with bilinear weights,
  // grouped by class: the class with most weight wins, so coastlines follow
  // a smooth curve through the tile corners instead of stair-steps. Inside a
  // class, colors blend (depth shading, plains → highland → mountain) over
  // the middle half of each tile step only, so detail stays crisp.
  ivec2 size = textureSize(uTerrain, 0);
  vec2 q = vUV * vec2(size) - 0.5;
  vec2 fl = floor(q);
  vec2 f = q - fl;
  vec2 fc = smoothstep(0.25, 0.75, f);
  ivec2 i0 = ivec2(fl);
  ivec2 hi = size - 1;

  vec3 sum0 = vec3(0.0), sum1 = vec3(0.0), sum2 = vec3(0.0);
  float w0 = 0.0, w1 = 0.0, w2 = 0.0;
  float c0 = 0.0, c1 = 0.0, c2 = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    ivec2 tc = clamp(i0 + o, ivec2(0), hi);
    // w decides the class (smooth edges), wc the color mix (crisp inside).
    float w = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
    float wc = (o.x == 1 ? fc.x : 1.0 - fc.x) * (o.y == 1 ? fc.y : 1.0 - fc.y);
    vec3 c = texelFetch(uTerrain, tc, 0).rgb;
    int cls = terrainClass(tc);
    // Tiny floor so a class that wins on w always has some color weight.
    wc = w > 0.0 ? max(wc, 1e-4 * w) : 0.0;
    if (cls == 0) { sum0 += c * wc; w0 += w; c0 += wc; }
    else if (cls == 1) { sum1 += c * wc; w1 += w; c1 += wc; }
    else { sum2 += c * wc; w2 += w; c2 += wc; }
  }

  // Winner and runner-up (by class weight), each with its mean color.
  vec3 topColor = sum0 / max(c0, 1e-8), secColor = sum1 / max(c1, 1e-8);
  float top = w0, sec = w1;
  if (w1 > top) {
    vec3 t = topColor; topColor = secColor; secColor = t;
    sec = top; top = w1;
  }
  vec3 col2 = sum2 / max(c2, 1e-8);
  if (w2 > top) { secColor = topColor; sec = top; topColor = col2; top = w2; }
  else if (w2 > sec) { secColor = col2; sec = w2; }
  if (sec <= 0.0) secColor = topColor;
  // Anti-alias the class edge over about one screen pixel.
  float d = top - sec;
  float cover = clamp(0.5 + d / max(fwidth(d), 1e-4), 0.5, 1.0);
  fragColor = vec4(mix(secColor, topColor, cover), 1.0);
}
