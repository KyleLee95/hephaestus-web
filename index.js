"use strict";
import geckos from "@geckos.io/server";
import { createCanvas, createImageData } from "canvas";
import * as wrtc from "wrtc";
const {
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  MediaStream,
} = wrtc.default;
const { RTCVideoSink, RTCVideoSource, i420ToRgba, rgbaToI420 } =
  wrtc.default.nonstandard;

import gl from "gl";

import * as THREE from "three";

import adapter from "webrtc-adapter";
const width = 640;
const height = 480;

// \/\/\/\/\/\/\/\/\/\/\/\/\/\\/ ALL THE THREEJS STUFF \/\/\/\/\/\/\/\/\/\/\/\/\/
const { scene, camera } = createScene();

const renderer = createRenderer({ width, height });

//For writing to the local file system
//fs.writeFileSync("test.ppm", toP3(image));
//process.exit(0);

function createScene() {
  const scene = new THREE.Scene();

  const box = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshPhongMaterial()
  );
  box.position.set(0, 0, 1);
  //box.castShadow = true;

  var SPEED = 0.01;
  setInterval(() => {
    box.rotation.x -= SPEED * 2;
    box.rotation.y -= SPEED;
    box.rotation.z -= SPEED * 3;
    //    console.log("box rotation", box.rotation);
  });

  scene.add(box);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(100, 100),
    new THREE.MeshPhongMaterial()
  );
  //ground.receiveShadow = true;
  scene.add(ground);

  const light = new THREE.PointLight();
  light.position.set(3, 3, 5);
  // light.castShadow = true;
  scene.add(light);

  const camera = new THREE.PerspectiveCamera();
  camera.up.set(0, 0, 1);
  camera.position.set(-3, 3, 3);
  camera.lookAt(box.position);
  scene.add(camera);

  return { scene, camera, box };
}

function createRenderer({ height, width }) {
  // THREE expects a canvas object to exist, but it doesn't actually have to work.
  const canvas = {
    width,
    height,
    addEventListener: (event) => {},
    removeEventListener: (event) => {},
  };

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
    context: gl(width, height, {
      preserveDrawingBuffer: true,
    }),
  });
  return renderer;
}

function extractPixels(context) {
  const width = context.drawingBufferWidth;
  const height = context.drawingBufferHeight;

  //WHAT WE WANT IS FROM RIGHT HERE.
  //WE WANT THE PIXELS AND THE RGBA
  const frameBufferPixels = new Uint8Array(width * height * 4);
  context.readPixels(
    0,
    0,
    width,
    height,
    context.RGBA,
    context.UNSIGNED_BYTE,
    frameBufferPixels
  );
  // The framebuffer coordinate space has (0, 0) in the bottom left, whereas images usually
  // have (0, 0) at the top left. Vertical flipping follows:
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let fbRow = 0; fbRow < height; fbRow += 1) {
    let rowData = frameBufferPixels.subarray(
      fbRow * width * 4,
      (fbRow + 1) * width * 4
    );
    let imgRow = height - fbRow - 1;
    pixels.set(rowData, imgRow * width * 4);
  }
  //take the output, convert it to a WebRTC track (manually) and then send it to the client to be dropped in as a video
  return { width, height, pixels };
}

// \/\/\/\/\/\/\/\/\/\/\/\/\/\/ ALL THE WEBRTC STUFF \/\/\/\/\/\/\/\/\/\/\/\/\/\/
let canvas;
let context;

var localVideo;
var localStream;
var remoteVideo;
var peerConnection;
var uuid;
var serverConnection;

function beforeOffer(peerConnection) {
  const source = new RTCVideoSource();
  const track = source.createTrack();
  const transceiver = peerConnection.addTransceiver(track);
  const sink = new RTCVideoSink(transceiver.receiver.track);

  let lastFrame = null;

  function onFrame({ frame }) {
    console.log("here", frame);
    lastFrame = frame;
  }
  sink.onframe = ({ frame }) => {
    // this event fires out of sync with ondata
    // do some processing
    //    source.onFrame(frame); // <- if we had timestamp data, we could synchronize this
  };
  //  sink.addEventListener("frame", onFrame);
  canvas = createCanvas(width, height);
  context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);

  //Main loop.
  // responsible for re-rendering the scene, capturing the pixels, and then sending them to the client.
  // This is effectively the "game loop"

  const interval = setInterval(() => {
    renderer.render(scene, camera);
    const image = extractPixels(renderer.getContext());

    const imageData = createImageData(image.pixels, image.width, image.height);

    const i420Frame = {
      width,
      height,
      data: new Uint8ClampedArray(1.5 * width * height),
    };

    rgbaToI420(imageData, i420Frame);
    source.onFrame(i420Frame);
  });

  // NOTE(mroberts): This is a hack so that we can get a callback when the
  // RTCPeerConnection is closed. In the future, we can subscribe to
  // "connectionstatechange" events.
  const { close } = peerConnection;
  peerConnection.close = function () {
    clearInterval(interval);
    sink.stop();
    track.stop();
    return close.apply(this, arguments);
  };
}

// ----------------------------------------------------------------------------------------

const io = geckos();

io.listen(3000); // default port is 9208

io.onConnection((channel) => {
  channel.onDisconnect(() => {
    console.log(`${channel.id} got disconnected`);
  });

  channel.on("chat message", (data) => {
    console.log(`got ${data} from "chat message"`);
    // emit the "chat message" data to all channels in the same room
    io.room(channel.roomId).emit("chat message", data);
  });
  var peerConnectionConfig = {
    iceServers: [
      { urls: "stun:stun.stunprotocol.org:3478" },
      { urls: "stun:stun.l.google.com:19302" },
    ],
  };

  function pageReady() {
    uuid = createUUID();

    //    peerConnection = new RTCPeerConnection(peerConnectionConfig);
    //    beforeOffer(peerConnection);

    channel.on("message", gotMessageFromServer);
  }
  function start(isCaller) {
    if (!peerConnection) {
      peerConnection = new RTCPeerConnection(peerConnectionConfig);
    }

    const source = new RTCVideoSource();
    //  let track = source.createTrack();
    const track = source.createTrack();
    //    const transceiver = peerConnection.addTransceiver(track);
    //    const sink = new RTCVideoSink(transceiver.receiver.track);
    const sink = new RTCVideoSink(track);

    const mediaStream = new MediaStream();
    let lastFrame = null;
    peerConnection.addTrack(track, mediaStream);
    sink.onframe = ({ frame }) => {
      //      console.log("here");
      lastFrame = frame;
      const currTrack = source.createTrack(frame);
      mediaStream.addTrack(currTrack);
      console.log("adding track");
      peerConnection.addTrack(currTrack, mediaStream);
    };

    canvas = createCanvas(width, height);
    context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);

    //Main loop.
    // responsible for re-rendering the scene, capturing the pixels, and then sending them to the client.
    // This is effectively the "game loop"

    const interval = setInterval(() => {
      renderer.render(scene, camera);
      const image = extractPixels(renderer.getContext());

      const imageData = createImageData(
        image.pixels,
        image.width,
        image.height
      );

      const i420Frame = {
        width,
        height,
        data: new Uint8ClampedArray(1.5 * width * height),
      };
      console.log("i420Frame", i420Frame);
      rgbaToI420(imageData, i420Frame);
      source.onFrame(i420Frame);
    });

    // NOTE(mroberts): This is a hack so that we can get a callback when the
    // RTCPeerConnection is closed. In the future, we can subscribe to
    // "connectionstatechange" events.
    const { close } = peerConnection;
    peerConnection.close = function () {
      clearInterval(interval);
      sink.stop();
      track.stop();
      return close.apply(this, arguments);
    };
    peerConnection.onicecandidate = gotIceCandidate;
    peerConnection.ontrack = gotRemoteStream;
    //doesnt work but needed to send data to client    peerConnection.addStream(localStream);

    var mediaConstraints = {
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    };
    if (isCaller) {
      peerConnection
        .createOffer(mediaConstraints)
        .then(createdDescription)
        .catch(errorHandler);
    }
  }

  function getUserMediaSuccess(stream) {
    localStream = stream;
  }
  function gotMessageFromServer(message) {
    if (!peerConnection) start(false);
    var signal = message;

    // Ignore messages from ourself
    if (signal.uuid == uuid) return;
    console.log("signal", signal);
    if (signal.sdp) {
      peerConnection
        .setRemoteDescription(new RTCSessionDescription(signal.sdp))
        .then(function () {
          // Only create answers in response to offers
          if (signal.sdp.type == "offer") {
            peerConnection
              .createAnswer()
              .then(createdDescription)
              .catch(errorHandler);
          }
        })
        .catch(errorHandler);
    } else if (signal.ice) {
      peerConnection
        .addIceCandidate(new RTCIceCandidate(signal.ice))
        .catch(errorHandler);
    }
  }

  function gotIceCandidate(event) {
    if (event.candidate != null) {
      channel.emit("message", { ice: event.candidate, uuid: uuid });
    }
  }

  function createdDescription(description) {
    peerConnection
      .setLocalDescription(description)
      .then(function () {
        channel.emit("message", {
          sdp: peerConnection.localDescription,
          uuid: uuid,
        });
      })
      .catch(errorHandler);
  }

  function gotRemoteStream(event) {
    console.log("got remote stream");
    //remoteVideo.srcObject = event.streams[0];
  }

  function errorHandler(error) {
    console.log(error);
  }

  // Taken from http://stackoverflow.com/a/105074/515584
  // Strictly speaking, it's not a real UUID, but it gets the job done here
  function createUUID() {
    function s4() {
      return Math.floor((1 + Math.random()) * 0x10000)
        .toString(16)
        .substring(1);
    }

    return (
      s4() +
      s4() +
      "-" +
      s4() +
      "-" +
      s4() +
      "-" +
      s4() +
      "-" +
      s4() +
      s4() +
      s4()
    );
  }
  pageReady();
});
