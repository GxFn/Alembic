import { pack as android } from "./android.js";
import { pack as django } from "./django.js";
import { pack as fastapi } from "./fastapi.js";
import { pack as goGrpc } from "./go-grpc.js";
import { pack as goWeb } from "./go-web.js";
import { pack as nextjs } from "./nextjs.js";
import { pack as nodeServer } from "./node-server.js";
import { pack as pythonLangchain } from "./python-langchain.js";
import { pack as pythonMl } from "./python-ml.js";
import { pack as react } from "./react.js";
import { pack as rustTokio } from "./rust-tokio.js";
import { pack as rustWeb } from "./rust-web.js";
import { pack as spring } from "./spring.js";
import { pack as vue } from "./vue.js";

export const ENGINEERING_ENHANCEMENT_PACKS = [
  react,
  nextjs,
  vue,
  nodeServer,
  django,
  fastapi,
  pythonMl,
  pythonLangchain,
  spring,
  android,
  goWeb,
  goGrpc,
  rustWeb,
  rustTokio,
] as const;

export {
  android,
  django,
  fastapi,
  goGrpc,
  goWeb,
  nextjs,
  nodeServer,
  pythonLangchain,
  pythonMl,
  react,
  rustTokio,
  rustWeb,
  spring,
  vue,
};
