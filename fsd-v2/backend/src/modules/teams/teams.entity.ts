import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

// BotConversationRef stores a per-user Teams ConversationReference so we
// can send proactive notifications later (booking approved, reminder,
// etc) without the user needing to be online.
//
// userId is the v2 users.id; aadObjectId is the Microsoft Entra ID so
// inbound activities can be matched back to the local account.
@Entity('teams_conversation_refs')
@Index(['userId'], { unique: true })
@Index(['aadObjectId'])
export class BotConversationRef {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId!: string;
  @Column({ name: 'aad_object_id', type: 'varchar', length: 64, default: '' })
  aadObjectId!: string;
  @Column({ name: 'service_url', type: 'varchar', length: 512 }) serviceURL!: string;
  @Column({ name: 'conversation_id', type: 'varchar', length: 512 }) conversationID!: string;
  @Column({ name: 'channel_id', type: 'varchar', length: 64, default: 'msteams' })
  channelID!: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
