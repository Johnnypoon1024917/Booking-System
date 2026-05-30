import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ConnectorClient, MicrosoftAppCredentials, JwtTokenValidation,
  SimpleCredentialProvider, AuthenticationConfiguration,
} from 'botframework-connector';
import { Activity } from 'botframework-schema';
import { BotConversationRef } from './teams.entity';

// TeamsService — Bot Framework auth + proactive message dispatch.
//
// Auth: inbound activities carry an Authorization: Bearer <JWT> signed
// by Microsoft's bot framework keys. We delegate validation to
// botframework-connector's JwtTokenValidation, which fetches the JWKS,
// verifies the signature, the iss, and that aud matches our app id —
// the same algorithm v1's botframework_auth.go implements by hand.
//
// Proactive sends use ConnectorClient with the MicrosoftAppCredentials
// helper for OAuth token acquisition. Credentials come from
// BOT_APP_ID / BOT_APP_PASSWORD.
//
// In dev BOT_APP_ID may be unset — we skip validation in that mode so
// local Teams emulator testing isn't blocked. Production must set it;
// otherwise this is a security hole.
@Injectable()
export class TeamsService {
  private readonly log = new Logger(TeamsService.name);
  private readonly appId = process.env.BOT_APP_ID || '';
  private readonly appPassword = process.env.BOT_APP_PASSWORD || '';
  private readonly credentialProvider = new SimpleCredentialProvider(this.appId, this.appPassword);

  constructor(
    @InjectRepository(BotConversationRef)
    private readonly refs: Repository<BotConversationRef>,
  ) {}

  // validateInbound — JWT-validates a raw Authorization header against
  // Microsoft's bot framework keys. Throws UnauthorizedException on any
  // mismatch (signature, audience, issuer, expiry).
  async validateInbound(authHeader: string, activity: Partial<Activity>): Promise<void> {
    if (!this.appId) {
      this.log.warn('BOT_APP_ID not set — accepting inbound activity without JWT validation');
      return;
    }
    try {
      // v4.x positional args:
      //   (activity, authHeader, credentialProvider, channelService, authConfig?)
      // channelService is empty for the public cloud; AuthenticationConfiguration
      // moves to position 5.
      await JwtTokenValidation.authenticateRequest(
        activity as Activity,
        authHeader || '',
        this.credentialProvider,
        '',
        new AuthenticationConfiguration(),
      );
    } catch (e) {
      this.log.warn(`teams: auth: ${(e as Error).message}`);
      throw new UnauthorizedException('bot framework authentication failed');
    }
  }

  // upsertConversationRef captures a ConversationReference on the first
  // inbound activity from a user so we can reach them again later.
  async upsertConversationRef(
    tenantId: string, userId: string, aadObjectId: string,
    activity: Partial<Activity>,
  ): Promise<void> {
    if (!activity.conversation?.id || !activity.serviceUrl) return;
    const existing = await this.refs.findOne({ where: { userId } });
    const payload: Partial<BotConversationRef> = {
      tenantId, userId, aadObjectId,
      serviceURL: activity.serviceUrl,
      conversationID: activity.conversation.id,
      channelID: activity.channelId || 'msteams',
    };
    if (existing) {
      await this.refs.update({ id: existing.id }, payload);
    } else {
      await this.refs.save(this.refs.create(payload));
    }
  }

  // proactiveSend posts a message (text or adaptive card) to the user's
  // stored ConversationReference. Throws if the user has never greeted
  // the bot (we have no serviceUrl/convId to address them with).
  async proactiveSend(
    userId: string, text: string, card?: Record<string, any>,
  ): Promise<void> {
    const ref = await this.refs.findOne({ where: { userId } });
    if (!ref) throw new Error('no conversation reference — user must greet the bot at least once');
    if (!this.appId || !this.appPassword) {
      throw new Error('BOT_APP_ID / BOT_APP_PASSWORD not configured');
    }

    const credentials = new MicrosoftAppCredentials(this.appId, this.appPassword);
    const connector = new ConnectorClient(credentials, { baseUri: ref.serviceURL });
    const activity: Partial<Activity> = {
      type: 'message',
      text,
      locale: 'en-US',
    };
    if (card) {
      (activity as any).attachments = [
        { contentType: 'application/vnd.microsoft.card.adaptive', content: card },
      ];
    }
    await connector.conversations.sendToConversation(ref.conversationID, activity as Activity);
  }

  // The Teams app manifest — served so admins can side-load the bot
  // from the SPA without hand-crafting JSON.
  manifest(): Record<string, any> {
    const id = this.appId || '00000000-0000-0000-0000-000000000000';
    return {
      $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json',
      manifestVersion: '1.16',
      version: '1.0.0',
      id,
      developer: {
        name: 'FSD MRBS', websiteUrl: 'https://fsd-mrbs.local',
        privacyUrl: 'https://fsd-mrbs.local/privacy',
        termsOfUseUrl: 'https://fsd-mrbs.local/terms',
      },
      name: { short: 'FSD Rooms', full: 'FSD Resource Booking' },
      description: {
        short: 'Book rooms from Teams chat',
        full: 'Search availability, reserve rooms, and check approvals from inside Microsoft Teams.',
      },
      icons: { color: 'icon-color.png', outline: 'icon-outline.png' },
      accentColor: '#0a1f44',
      bots: [{
        botId: id, scopes: ['personal', 'team', 'groupchat'],
        isNotificationOnly: false, supportsCalling: false, supportsVideo: false,
        commandLists: [{
          scopes: ['personal', 'team', 'groupchat'],
          commands: [
            { title: 'find', description: 'Find an available room' },
            { title: 'my', description: 'Show my upcoming bookings' },
            { title: 'help', description: 'What this bot can do' },
          ],
        }],
      }],
      validDomains: ['fsd-mrbs.local'],
    };
  }
}
