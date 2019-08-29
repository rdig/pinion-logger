import IPFS = require('ipfs');
import EventEmitter = require('events');
import debug = require('debug');
import FSE = require('fs-extra');
import colonyJS = require('@colony/colony-js-client');

import customLibp2pBundle from './customLibp2pBundle';
import { PinnerActions } from './actions';
import { NETWORKS } from './defaults';

interface Message<T, P> {
  type: T;
  // Can be a store address or an ipfs peer id
  to?: string;
  payload: P;
}

interface Options {
  repo?: string;
  privateKey?: string;
}

const {
  PINION_IPFS_CONFIG_FILE,
  NODE_ENV,
  NETWORK_ID = '5',
  STATS_FILE = 'stats/knownEntities.json',
} = process.env;

const configFile =
  PINION_IPFS_CONFIG_FILE ||
  `${__dirname}/../ipfsConfig.${NODE_ENV || 'development'}.json`;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require(configFile);

const logMonitor = debug('pinion-logger:watch');

const colonyDiscoveryLogger = debug('pinion-logger:NEW_COLONY');
const userDiscoveryLogger = debug('pinion-logger:NEW_USER');

const blankStats = { users: {}, colonies: {} };

class IPFSNode {
  private readonly events: EventEmitter;

  private readonly ipfs: IPFS;

  private readonly room: string;

  private readyPromise!: Promise<void>;

  private lastKnownColony: string = '0x';

  private lastKnownUser: string = '0x';

  private knownEntities: Record<string, any> = blankStats;

  public id: string = '';

  private networkClient = colonyJS.getNetworkClient(
    NETWORKS[`N${NETWORK_ID}`],
    {
      type: 'generic',
      subtype: 'generic',
    },
  );

  constructor(
    events: EventEmitter,
    room: string,
    { repo, privateKey }: Options,
  ) {
    this.events = events;
    this.ipfs = new IPFS({
      repo,
      init: { privateKey },
      config,
      EXPERIMENTAL: { pubsub: true },
      libp2p: customLibp2pBundle,
    });
    this.readyPromise = new Promise((resolve): void => {
      this.ipfs.on('ready', resolve);
    });
    this.room = room;

    FSE.readJson(STATS_FILE, (err, entities) => {
      if (err) {
        return;
      }
      this.knownEntities = entities;
    });
  }

  private handlePubsubMessage = async (
    msg: IPFS.PubsubMessage,
  ): Promise<void> => {
    if (!(msg && msg.from && msg.data)) {
      return;
    }

    // Don't handle messages from ourselves
    if (msg.from === this.id) return;

    const {
      type,
      payload: { address: addressToParse = '0x' },
    } = JSON.parse(msg.data.toString());

    if (type !== PinnerActions.HAVE_HEADS) {
      return;
    }

    let newColonyAddress, newUserAddress;
    if (addressToParse.includes(`network.${NETWORK_ID}.colony`)) {
      newColonyAddress = addressToParse.match(
        /colony\.(\w+)(?:\.task(?:s|\.(\w+)))?/,
      )[1];
      if (
        (this.knownEntities.colonies &&
          this.knownEntities.colonies[newColonyAddress]) ||
        this.lastKnownColony === newColonyAddress
      ) {
        this.lastKnownColony = newColonyAddress;
        return;
      }
    }

    if (addressToParse.includes(`network.${NETWORK_ID}.user`)) {
      newUserAddress = addressToParse.match(
        /user(?:Profile|Metadata|Inbox)\.(.+)/,
      )[1];
      if (
        (this.knownEntities.users &&
          this.knownEntities.users[newUserAddress]) ||
        this.lastKnownUser === newUserAddress
      ) {
        this.lastKnownUser = newUserAddress;
        return;
      }
    }

    if (newColonyAddress || newColonyAddress) {
      return FSE.readJson(STATS_FILE, (err, entities) => {
        if (err) {
          return FSE.outputJson(STATS_FILE, blankStats, () => null);
        }
        this.networkClient
          .then(client =>
            client.lookupRegisteredENSDomain.call({
              ensAddress: newColonyAddress || newUserAddress,
            }),
          )
          .then(({ domain: ensName }) => {
            const currentEntities = Object.assign({}, entities);
            const truncatedEnsName = ensName.slice(0, ensName.indexOf('.'));
            if (newColonyAddress) {
              currentEntities.colonies[newColonyAddress] = truncatedEnsName;
              this.lastKnownColony = newColonyAddress;
              colonyDiscoveryLogger(newColonyAddress, truncatedEnsName);
            } else {
              currentEntities.users[newUserAddress] = truncatedEnsName;
              this.lastKnownUser = newUserAddress;
              userDiscoveryLogger(newUserAddress, truncatedEnsName);
            }
            FSE.outputJson(STATS_FILE, currentEntities, () => null);
            this.knownEntities = currentEntities;
          })
          .catch();
      });
    }
  };

  public async getId(): Promise<string> {
    const { id } = await this.ipfs.id();
    return id;
  }

  public async ready(): Promise<void> {
    if (this.ipfs.isOnline()) return;
    return this.readyPromise;
  }

  public async start(): Promise<void> {
    try {
      await this.ready();
      this.id = await this.getId();
      await this.ipfs.pubsub.subscribe(this.room, this.handlePubsubMessage);
      logMonitor(`Joined room: ${this.room}`);
      logMonitor(
        `Listening for network: ${NETWORKS[`N${NETWORK_ID}`]} (${NETWORK_ID})`,
      );
    } catch (error) {
      /*
       * Fail silently
       */
      return;
    }
  }

  public async stop(): Promise<void> {
    await this.ipfs.pubsub.unsubscribe(this.room, this.handlePubsubMessage);
    return this.ipfs.stop();
  }
}

export default IPFSNode;
