import pAll from 'p-all'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync.js'
import { v4 as uuidv4 } from 'uuid'
import { uuidSchema } from '@briefer/types'
import { z } from 'zod'
import { decoding, encoding } from 'lib0'
import pino from 'pino'

export interface IPubSub {
  publish(message: MessageYProtocol): Promise<void>
  subscribe(
    callback: (message: MessageYProtocol) => void
  ): Promise<() => Promise<void>>
}

const syncProtocolMessageType = 0
const awarenessProtocolMessageType = 1
const pingProtocolMessageType = 2
const pongProtocolMessageType = 3
const PING_TIMEOUT = 30 * 1000 // 30 seconds
const RESYNC_INTERVAL = 30 * 1000 // 30 seconds

export const MessageYProtocol = z.object({
  id: z.string(),
  data: z.instanceof(Uint8Array),
  senderId: uuidSchema,
  targetId: z.union([z.literal('broadcast'), uuidSchema]),
  clock: z.number(),
})
export type MessageYProtocol = z.infer<typeof MessageYProtocol>

export class PubSubProvider {
  private pubsubId = uuidv4()
  private subscription: (() => Promise<void>) | null = null
  private syncedPeers = new Map<string, { waitingPong: boolean }>()
  private resyncInterval: NodeJS.Timeout | null = null
  private pingInterval: NodeJS.Timeout | null = null

  constructor(
    private readonly id: string,
    private readonly ydoc: Y.Doc,
    private readonly clock: number,
    private readonly pubsub: IPubSub,
    private readonly logger: pino.Logger
  ) {}

  public getSyncedPeers() {
    return this.syncedPeers
  }

  public async connect() {
    if (this.subscription) {
      throw new Error('Already connected')
    }

    this.subscription = await this.pubsub.subscribe(this.onSubMessage)

    await this.sendSync1('broadcast')

    this.ydoc.on('update', this.updateHandler)

    this.resyncInterval = setInterval(() => {
      this.sendSync1('broadcast')
    }, RESYNC_INTERVAL)

    this.pingInterval = setTimeout(this.onPingInterval, PING_TIMEOUT)
  }

  private onPingInterval = async () => {
    for (const [peer, { waitingPong }] of this.syncedPeers) {
      if (waitingPong) {
        this.logger.trace(
          {
            id: this.id,
            peer,
          },
          'Peer did not respond to ping in time, removing peer.'
        )
        this.syncedPeers.delete(peer)
      }
    }
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, pingProtocolMessageType)
    const data = encoding.toUint8Array(encoder)
    await pAll(
      Array.from(this.syncedPeers.keys()).map((peer) => async () => {
        await this.pubsub.publish({
          id: this.id,
          data,
          clock: this.clock,
          senderId: this.pubsubId,
          targetId: peer,
        })
        this.logger.trace(
          {
            id: this.id,
            pubsubId: this.pubsubId,
            peer,
          },
          'Sent ping message to peer'
        )
        this.syncedPeers.set(peer, { waitingPong: true })
      }),
      {
        concurrency: 5,
      }
    )

    this.pingInterval = setTimeout(this.onPingInterval, PING_TIMEOUT)
  }

  public async disconnect() {
    if (!this.subscription) {
      throw new Error('Not connected')
    }

    if (this.resyncInterval) {
      clearInterval(this.resyncInterval)
      this.resyncInterval = null
    }

    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }

    this.ydoc.off('update', this.updateHandler)

    await this.subscription()
    this.subscription = null
  }

  private updateHandler = async (update: Uint8Array, origin: any) => {
    if (origin === this) {
      this.logger.trace(
        {
          id: this.id,
          pubsubId: this.pubsubId,
        },
        'Ignoring own update'
      )
      return
    }

    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, syncProtocolMessageType)
    syncProtocol.writeUpdate(encoder, update)
    const data = encoding.toUint8Array(encoder)
    await pAll(
      Array.from(this.syncedPeers.keys()).map((peer) => async () => {
        const message: MessageYProtocol = {
          id: this.id,
          data,
          clock: this.clock,
          senderId: this.pubsubId,
          targetId: peer,
        }
        await this.pubsub.publish(message)
      }),
      {
        concurrency: 5,
      }
    )
  }

  private async sendSync1(targetId: string) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, syncProtocolMessageType)
    syncProtocol.writeSyncStep1(encoder, this.ydoc)

    const data = encoding.toUint8Array(encoder)
    const message: MessageYProtocol = {
      id: this.id,
      data,
      clock: this.clock,
      senderId: this.pubsubId,
      targetId,
    }
    await this.pubsub.publish(message)
    this.logger.trace(
      {
        id: this.id,
        targetId,
      },
      'Sent sync1 message'
    )
  }

  private onSubMessage = async (message: MessageYProtocol) => {
    if (message.id !== this.id) {
      this.logger.trace(
        {
          thisId: this.id,
          messageId: message.id,
        },
        'Ignoring sub message for different doc'
      )
      return
    }

    if (message.senderId === this.pubsubId) {
      this.logger.trace(
        {
          id: this.id,
        },
        'Ignoring own sub message'
      )
      return
    }

    if (
      message.targetId !== 'broadcast' &&
      message.targetId !== this.pubsubId
    ) {
      this.logger.trace(
        {
          id: this.id,
          messangeSenderId: message.senderId,
          messageTargetId: message.targetId,
          thisSenderId: this.pubsubId,
        },
        'Ignoring y-protocol message for different target'
      )
      return
    }

    if (message.clock < this.clock) {
      this.logger.trace(
        {
          id: this.id,
          senderId: message.senderId,
          targetId: message.targetId,
          clock: message.clock,
          thisClock: this.clock,
        },
        'Ignoring message with old clock'
      )
      return
    }

    if (message.clock > this.clock) {
      // TODO: we need to resync if we receive a message with a higher clock
      this.logger.trace(
        {
          id: this.id,
          senderId: message.senderId,
          targetId: message.targetId,
          clock: message.clock,
          thisClock: this.clock,
        },
        'Ignoring message with higher clock'
      )
      return
    }
    this.logger.trace(
      {
        id: this.id,
        senderId: message.senderId,
        targetId: message.targetId,
      },
      'Handling foreign sub message'
    )

    return this.handleMessage(message)
  }

  private async handleMessage(message: MessageYProtocol) {
    const encoder = encoding.createEncoder()
    const decoder = decoding.createDecoder(message.data)
    const protocolType = decoding.readVarUint(decoder)
    switch (protocolType) {
      case syncProtocolMessageType: {
        encoding.writeVarUint(encoder, syncProtocolMessageType)
        this.readSyncMessage(message, decoder, encoder, this)

        // If the `encoder` only contains the type of reply message and no
        // message, there is no need to send the message. When `encoder` only
        // contains the type of reply, its length is 1.
        if (encoding.length(encoder) > 1) {
          const encodedMessage = encoding.toUint8Array(encoder)
          const replyMessage: MessageYProtocol = {
            id: this.id,
            data: encodedMessage,
            clock: this.clock,
            senderId: this.pubsubId,
            targetId: message.senderId,
          }
          await this.pubsub.publish(replyMessage)
          this.logger.trace(
            {
              id: this.id,
            },
            'Sent reply message'
          )
        }
        break
      }
      case awarenessProtocolMessageType:
        this.logger.error(
          {
            id: this.id,
            senderId: message.senderId,
            targetId: message.targetId,
          },
          'Received awareness message, but awareness messages are not supported yet.'
        )
        break
      case pingProtocolMessageType: {
        this.readPingMessage(message, encoder)
        break
      }
      case pongProtocolMessageType: {
        this.readPongMessage(message)
        break
      }
      default: {
        this.logger.error(
          {
            id: this.id,
            protocolType,
          },
          'Received unknown protocol type'
        )
        break
      }
    }
  }

  private readSyncMessage(
    message: MessageYProtocol,
    decoder: decoding.Decoder,
    encoder: encoding.Encoder,
    transactionOrigin: any
  ): number {
    const messageType = decoding.readVarUint(decoder)
    switch (messageType) {
      case syncProtocol.messageYjsSyncStep1:
        this.readSyncStep1(message, decoder, encoder)
        break
      case syncProtocol.messageYjsSyncStep2:
        this.readSyncStep2(message, decoder, transactionOrigin)
        break
      case syncProtocol.messageYjsUpdate:
        this.readUpdate(message, decoder, transactionOrigin)
        break
      default:
        this.logger.error(
          {
            id: this.id,
            senderId: message.senderId,
            targetId: message.targetId,
            messageSize: message.data.length,
            messageType,
          },
          'Received unknown message type'
        )
    }
    return messageType
  }

  private readSyncStep1(
    message: MessageYProtocol,
    decoder: decoding.Decoder,
    encoder: encoding.Encoder
  ) {
    this.syncedPeers.set(message.senderId, { waitingPong: false })
    this.logger.trace(
      {
        id: this.id,
        senderId: message.senderId,
        targetId: message.targetId,
        messageSize: message.data.length,
        messageType: 'syncStep1',
      },
      'Reading sync1 message'
    )
    syncProtocol.readSyncStep1(decoder, encoder, this.ydoc)
  }

  private readSyncStep2(
    message: MessageYProtocol,
    decoder: decoding.Decoder,
    transactionOrigin: any
  ) {
    this.logger.trace(
      {
        id: this.id,
        senderId: message.senderId,
        targetId: message.targetId,
        messageSize: message.data.length,
        messageType: 'syncStep2',
      },
      'Reading sync2 message'
    )
    syncProtocol.readSyncStep2(decoder, this.ydoc, transactionOrigin)
    this.syncedPeers.set(message.senderId, { waitingPong: false })
  }

  private readUpdate(
    message: MessageYProtocol,
    decoder: decoding.Decoder,
    transactionOrigin: any
  ) {
    this.logger.trace(
      {
        id: this.id,
        senderId: message.senderId,
        targetId: message.targetId,
        messageSize: message.data.length,
        messageType: 'update',
      },
      'Reading update message'
    )
    syncProtocol.readUpdate(decoder, this.ydoc, transactionOrigin)
  }

  private async readPingMessage(
    message: MessageYProtocol,
    encoder: encoding.Encoder
  ) {
    this.logger.trace(
      {
        id: this.id,
        senderId: message.senderId,
        targetId: message.targetId,
        messageSize: message.data.length,
        messageType: 'ping',
      },
      'Reading ping message'
    )
    encoding.writeVarUint(encoder, pongProtocolMessageType)
    await this.pubsub.publish({
      id: this.id,
      data: encoding.toUint8Array(encoder),
      clock: this.clock,
      senderId: this.pubsubId,
      targetId: message.senderId,
    })
  }

  private async readPongMessage(message: MessageYProtocol) {
    this.logger.trace(
      {
        id: this.id,
        senderId: message.senderId,
        targetId: message.targetId,
        messageSize: message.data.length,
        messageType: 'pong',
      },
      'Reading pong message from peer'
    )
    if (this.syncedPeers.has(message.senderId)) {
      this.syncedPeers.set(message.senderId, { waitingPong: false })
    }
  }
}
