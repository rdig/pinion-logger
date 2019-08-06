import IPFS = require('ipfs');
import EventEmitter = require('events');
import debug = require('debug');
import PeerMonitor = require('ipfs-pubsub-peer-monitor');
import FS = require('fs');
import UTIL = require('util');
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

const logMonitor = debug('pinion-monitor:log');

const colonyDiscoveryLogger = debug('pinion-monitor:DISCOVERED_NEW_COLONY');
const userDiscoveryLogger = debug('pinion-monitor:DISCOVERED_NEW_USER');

class IPFSNode {
  private readonly events: EventEmitter;

  private readonly ipfs: IPFS;

  private readonly room: string;

  private readyPromise!: Promise<void>;

  private lastKnownColony: string = '0x';

  private knownColonies: Record<string, any> = {};

  private lastKnownUser: string = '0x';

  private knownUsers: Record<string, any> = {};

  private knownEntities: Record<string, any> = {
    users: {},
    colonies: {},
  };

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

    FS.readFile('knownColonies.json', (err, colonies) => {
      if (err) {
        return;
      }
      this.knownColonies = JSON.parse(colonies.toString());
    });

    FS.readFile('knownUsers.json', (err, users) => {
      if (err) {
        return;
      }
      this.knownUsers = JSON.parse(users.toString());
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

    /*
     * @TODO Proper Network ID handling
     */
    if (addressToParse.includes('network.1.colony')) {
      const [, newColonyAddress] = addressToParse.match(
        /colony\.(\w+)(?:\.task(?:s|\.(\w+)))?/,
      );
      if (
        this.knownColonies[newColonyAddress] ||
        this.lastKnownColony === newColonyAddress
      ) {
        this.lastKnownColony = newColonyAddress;
        return;
      }
      return FS.readFile('knownColonies.json', (err, colonies) => {
        if (err) {
          return FS.writeFile(
            'knownColonies.json',
            JSON.stringify({}),
            () => null,
          );
        }
        this.networkClient
          .then(client =>
            client.lookupRegisteredENSDomain.call({
              ensAddress: newColonyAddress,
            }),
          )
          .then(({ domain: newColonyENS }) => {
            const currentColonies = JSON.parse(colonies.toString());
            currentColonies[newColonyAddress] = newColonyENS;
            FS.writeFile(
              'knownColonies.json',
              JSON.stringify(currentColonies),
              () => null,
            );
            this.knownColonies = currentColonies;
            this.lastKnownColony = newColonyAddress;
            colonyDiscoveryLogger(newColonyAddress, newColonyENS);
          });
      });
    }

    /*
     * @TODO Proper Network ID handling
     */
    if (addressToParse.includes('network.1.user')) {
      const [, newUserAddress] = addressToParse.match(
        /user(?:Profile|Metadata|Inbox)\.(.+)/,
      );
      if (
        this.knownUsers[newUserAddress] ||
        this.lastKnownUser === newUserAddress
      ) {
        this.lastKnownUser = newUserAddress;
        return;
      }
      return FS.readFile('knownUsers.json', (err, users) => {
        if (err) {
          return FS.writeFile(
            'knownUsers.json',
            JSON.stringify({}),
            () => null,
          );
        }
        this.networkClient
          .then(client =>
            client.lookupRegisteredENSDomain.call({
              ensAddress: newUserAddress,
            }),
          )
          .then(({ domain: newUserENS }) => {
            const currentUsers = JSON.parse(users.toString());
            currentUsers[newUserAddress] = newUserENS;
            FS.writeFile(
              'knownUsers.json',
              JSON.stringify(currentUsers),
              () => null,
            );
            this.knownUsers = currentUsers;
            this.lastKnownUser = newUserAddress;
            userDiscoveryLogger(newUserAddress, newUserENS);
          });
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
    await this.ready();
    this.id = await this.getId();
    await this.ipfs.pubsub.subscribe(this.room, this.handlePubsubMessage);
    logMonitor(`Joined room: ${this.room}`);
  }

  public async stop(): Promise<void> {
    await this.ipfs.pubsub.unsubscribe(this.room, this.handlePubsubMessage);
    return this.ipfs.stop();
  }
}

export default IPFSNode;
