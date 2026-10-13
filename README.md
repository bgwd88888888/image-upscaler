# 本地 2K / 4K 图片增强

图片始终在浏览器本地处理，不上传服务器。页面提供两种可切换模式：

- **经典高清**：在线性光空间使用 Lanczos-3 等比缩放，支持无/轻/强三档锐化，结果稳定且不会生成原图中不存在的内容。
- **AI 超清**：经典高清结果作为完整底图，轻量 Real-ESRGAN-General-x4v3 只提供克制的高频细节层；与原图细节方向冲突的 AI 残差会被丢弃。WebGPU 优先并自动回退 WASM。

两种模式都保持宽高比、不裁切，支持长边 2560 的 2K 和长边 3840 的 4K，统一导出 PNG。

核心文件：

- `src/lanczos.ts`：线性光、预乘 Alpha 的可分离 Lanczos-3 与锐化实现。
- `src/lanczos.worker.ts`：经典高清 Worker。
- `src/realesrgan.ts`：AI 分块、上下文裁剪和结果合成。
- `src/realesrgan.worker.ts`：ONNX Runtime Web / WebGPU / WASM 推理 Worker。
- `public/models/`：约 5MB 的 Real-ESRGAN ONNX 模型及许可证。

## 本地运行

需要 [Node.js](https://nodejs.org)：

```bash
npm install
npm run dev
```

浏览器打开 http://127.0.0.1:43180，选择或拖入图片，切换算法与目标分辨率后等待处理完成。

首次使用 AI 超清时需加载约 5MB 模型和约 26MB 的本地 ONNX 推理运行时，浏览器缓存后无需重复下载。

## 检查

```bash
npm run check
npm run lint
npm run build
```
