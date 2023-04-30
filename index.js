"use strict";
import geckos from "@geckos.io/server";
import * as wrtc from "wrtc";
const {
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  MediaStream,
} = wrtc.default;
const { RTCVideoSink, RTCVideoSource, i420ToRgba, rgbaToI420 } =
  wrtc.default.nonstandard;

import { createCanvas, createImageData } from "canvas";
import gl from "gl";
import * as THREE from "three";

// ----------------------------------------------------------------------------------------

const io = geckos();

io.listen(3000); // default port is 9208
let testPos = 0;

const width = 640;
const height = 480;

// \/\/\/\/\/\/\/\/\/\/\/\/\/\/ ALL THE WEBRTC STUFF \/\/\/\/\/\/\/\/\/\/\/\/\/\/
let canvas;
let context;

var peerConnection;
var uuid;
io.onConnection((channel) => {
  // \/\/\/\/\/\/\/\/\/\/\/\/\/\\/ ALL THE THREEJS STUFF \/\/\/\/\/\/\/\/\/\/\/\/\/
  const { scene, camera } = createScene();

  const renderer = createRenderer({ width, height });
  function createScene() {
    const scene = new THREE.Scene();

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(100, 100),
      new THREE.MeshPhongMaterial()
    );
    // ground.receiveShadow = true;
    scene.add(ground);

    const light = new THREE.PointLight();
    light.position.set(3, 3, 5);
    // light.castShadow = true;
    scene.add(light);

    const camera = new THREE.PerspectiveCamera();
    camera.up.set(0, 0, 1);
    camera.position.set(-3, 3, 3);
    camera.lookAt(0, 0, 1);

    scene.add(camera);

    return { scene, camera };
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
  channel.onDisconnect(() => {
    console.log(`${channel.id} got disconnected`);
  });

  channel.on("test", (data) => {
    testPos += 1;
    console.log("canvas", canvas);
    camera.position.set(testPos, 0, 1);
  });

  channel.on("drag-canvas", (data) => {
    console.log(canvas);
  });

  channel.on("BoxGeometry", (data) => {
    const box = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial({ color: "orange" });
    const mesh = new THREE.Mesh(box, material);
    mesh.position.set(0, 0, 1);
    scene.add(mesh);
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
    //comes from node-webrtc nonstandard api.
    //basically, instead of having access to canvas.captureStream, we instead manually initialize the video source and the output(sink). We must also initialize our own MediaStream since the client is expecting a MediaStream object and not individual tracks
    const source = new RTCVideoSource();
    const track = source.createTrack();
    const sink = new RTCVideoSink(track);

    const mediaStream = new MediaStream();
    let lastFrame = null;

    //need to add an empty track just to initialize the connection
    //otherwise webrtc won't initialize ice candidate searching
    peerConnection.addTrack(track, mediaStream);

    //this is an event listener for the sink to listen for the source.onframe call below.
    sink.onframe = ({ frame }) => {
      lastFrame = frame;
      //convert the i420 frame to a webrtc MediaStreamTrack
      const currTrack = source.createTrack(frame);
      //add that track to the stream
      mediaStream.addTrack(currTrack);
      //and send over webRTC. The line below will trigger the client's "peerconnection.ontrack" handler which handles setting it to the html video tag
      peerConnection.addTrack(currTrack, mediaStream);
    };

    canvas = createCanvas(width, height);
    console.log("canvas", canvas);
    context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);

    //Main loop.
    // responsible for re-rendering the scene and capturing pixels
    // This is effectively the "game loop"

    const interval = setInterval(() => {
      renderer.render(scene, camera);
      const image = extractPixels(renderer.getContext());
      //converts the threejs pixels to rgba that can be convereted to i420
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
      rgbaToI420(imageData, i420Frame);
      //triggers the sink.onframe handler above
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
