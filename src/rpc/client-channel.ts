import type { grpc } from '@improbable-eng/grpc-web';
import {
  Request,
  RequestHeaders,
  RequestMessage,
  Response,
  Stream,
} from '../gen/proto/rpc/webrtc/v1/grpc_pb';
import { BaseChannel } from './base-channel';
import { ClientStream } from './client-stream';
import { ConnectionClosedError } from './connection-closed-error';

// MaxStreamCount is the max number of streams a channel can have.
const MaxStreamCount = 256;

interface activeClienStream {
  cs: ClientStream;
}

export class ClientChannel extends BaseChannel {
  private streamIDCounter = 0;
  private readonly streams = new Map<number, activeClienStream>();

  constructor(pc: RTCPeerConnection, dc: RTCDataChannel) {
    super(pc, dc);
    dc.addEventListener('message', (event: MessageEvent<'message'>) => {
      this.onChannelMessage(event);
    });
    pc.addEventListener('iceconnectionstatechange', () => {
      const state = pc.iceConnectionState;
      if (
        !(state === 'failed' || state === 'disconnected' || state === 'closed')
      ) {
        return;
      }
      this.onConnectionTerminated();
    });
    dc.addEventListener('close', () => this.onConnectionTerminated());
  }

  public transportFactory(): grpc.TransportFactory {
    return (opts: grpc.TransportOptions) => {
      return this.newStream(this.nextStreamID(), opts);
    };
  }

  private onConnectionTerminated() {
    // we may call this twice but we know closed will be true at this point.
    this.closeWithReason(new ConnectionClosedError('data channel closed'));
    const err = new ConnectionClosedError('connection terminated');
    for (const stream of this.streams.values()) {
      stream.cs.closeWithRecvError(err);
    }
  }

  private onChannelMessage(event: MessageEvent) {
    let resp: Response;
    try {
      resp = Response.deserializeBinary(
        new Uint8Array(event.data as ArrayBuffer)
      );
    } catch (error) {
      console.error('error deserializing message', error);
      return;
    }

    const stream = resp.getStream();
    if (stream === undefined) {
      console.error('no stream id; discarding');
      return;
    }

    const id = stream.getId();
    const activeStream = this.streams.get(id);
    if (activeStream === undefined) {
      console.error('no stream for id; discarding', 'id', id);
      return;
    }
    activeStream.cs.onResponse(resp);
  }

  private nextStreamID(): Stream {
    const stream = new Stream();
    const thisStreamId = this.streamIDCounter;
    this.streamIDCounter += 1;
    stream.setId(thisStreamId);
    return stream;
  }

  private newStream(
    stream: Stream,
    opts: grpc.TransportOptions
  ): grpc.Transport {
    if (this.isClosed()) {
      return new FailingClientStream(
        new ConnectionClosedError('connection closed'),
        opts
      );
    }
    let activeStream = this.streams.get(stream.getId());
    if (activeStream === undefined) {
      if (Object.keys(this.streams).length > MaxStreamCount) {
        return new FailingClientStream(new Error('stream limit hit'), opts);
      }
      const clientStream = new ClientStream(
        this,
        stream,
        (id: number) => this.removeStreamByID(id),
        opts
      );
      activeStream = { cs: clientStream };
      this.streams.set(stream.getId(), activeStream);
    }
    return activeStream.cs;
  }

  private removeStreamByID(id: number) {
    this.streams.delete(id);
  }

  public writeHeaders(stream: Stream, headers: RequestHeaders) {
    const request = new Request();
    request.setStream(stream);
    request.setHeaders(headers);
    this.write(request);
  }

  public writeMessage(stream: Stream, msg: RequestMessage) {
    const request = new Request();
    request.setStream(stream);
    request.setMessage(msg);
    this.write(request);
  }

  public writeReset(stream: Stream) {
    const request = new Request();
    request.setStream(stream);
    request.setRstStream(true);
    this.write(request);
  }
}

class FailingClientStream implements grpc.Transport {
  private readonly err: Error;
  private readonly opts: grpc.TransportOptions;

  constructor(err: Error, opts: grpc.TransportOptions) {
    this.err = err;
    this.opts = opts;
  }

  public start() {
    setTimeout(() => this.opts.onEnd(this.err));
  }

  // eslint-disable-next-line class-methods-use-this
  public sendMessage() {
    // do nothing.
  }

  // eslint-disable-next-line class-methods-use-this
  public finishSend() {
    // do nothing.
  }

  // eslint-disable-next-line class-methods-use-this
  public cancel() {
    // do nothing.
  }
}
