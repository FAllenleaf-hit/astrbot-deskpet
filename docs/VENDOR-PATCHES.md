# 对第三方渲染库做的补丁

`desktop-app/src/renderer/vendor/pixi-live2d-display.cubism4.min.js` 是
[pixi-live2d-display 0.4.0](https://github.com/guansss/pixi-live2d-display) 的 Cubism4 UMD 构建，
本项目在其上打了 **3 处补丁**，用于支持 Cubism 的「混合颜色」特性。

如果你升级了这个库，需要重新打补丁（下面的字符串替换是幂等的，可直接复用）。

## 补丁 1：片元着色器增加两个 uniform

**查找**

```js
"precision mediump float;varying vec2       v_texCoord;uniform vec4       u_baseColor;uniform sampler2D  s_texture0;void main(){   gl_FragColor = texture2D(s_texture0 , v_texCoord) * u_baseColor;}"
```

**替换为**

```js
"precision mediump float;varying vec2       v_texCoord;uniform vec4       u_baseColor;uniform vec4 u_mulColor;uniform vec4 u_scrColor;uniform sampler2D  s_texture0;void main(){   gl_FragColor = texture2D(s_texture0 , v_texCoord) * u_baseColor;   gl_FragColor.rgb = gl_FragColor.rgb * u_mulColor.rgb + u_scrColor.rgb * gl_FragColor.a;}"
```

对应 Cubism 的公式：`结果 = 贴图 × multiplyColor + screenColor × alpha`

## 补丁 2：绘制前记录当前 drawable 索引

**查找**（注意锚点必须唯一，`this.drawMesh(` 在该文件里只出现一次）

```js
this.drawMesh(
```

**替换为**

```js
globalThis.__dpDrawable=t,this.drawMesh(
```

> ⚠️ 第一次打补丁时我用的锚点是 `vs(t),this.getModel()...`，
> 结果**撞进了 `getDrawableVertexUvs(t)` 内部**，把代码改成了
> `getDrawableVertexUglobalThis.__dpDrawable=t,...`，运行时报
> `Cannot set properties of undefined`。务必用唯一锚点。

## 补丁 3：设置基础色后注入混合颜色

**查找**

```js
this.gl.uniform4f(n.uniformBaseColorLocation,h.R,h.G,h.B,h.A)}
```

**替换为**

```js
this.gl.uniform4f(n.uniformBaseColorLocation,h.R,h.G,h.B,h.A),globalThis.__dpSetBlendColor&&globalThis.__dpSetBlendColor(this.gl,n)}
```

## 配套的运行时实现

`desktop-app/src/renderer/renderer.js` 里的 `globalThis.__dpSetBlendColor`：

```js
globalThis.__dpSetBlendColor = function (gl, shaderSet) {
  const prog = shaderSet && shaderSet.shaderProgram;
  if (!prog) return;
  if (shaderSet.__mulLoc === undefined) {
    shaderSet.__mulLoc = gl.getUniformLocation(prog, 'u_mulColor');
    shaderSet.__scrLoc = gl.getUniformLocation(prog, 'u_scrColor');
  }
  // 按当前 drawable 索引取它的 multiply / screen 颜色
  ...
};
```

## 其它渲染修复（不需要改库）

| 问题 | 修复位置 |
|---|---|
| 裁剪遮罩缓冲写死 256×256 → 放大后大块台阶 | `renderer.js` 调 `setClippingMaskBufferSize(2048)` |
| 贴图缩小采样没有 mipmap | `renderer.js` 里对 `gl.texImage2D`/`texParameteri` 的保守包装（默认关闭，见 `glMipmapPatch`） |
| 整体抗锯齿 | `resolution = devicePixelRatio × renderScale(默认1.5)` |
