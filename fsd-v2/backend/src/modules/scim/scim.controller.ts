import {
  Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Query, Patch,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ScimService } from './scim.service';
import { Public } from '../../common/decorators/public.decorator';

// SCIM 2.0 endpoint. Mounted at the absolute /scim/v2 path (excluded
// from the api/v1 global prefix). Auth is a bearer token in the
// scim_tokens table — NOT a JWT. We mark each handler @Public() so
// the global JwtAuthGuard doesn't reject the request, then resolve
// the SCIM token ourselves inside each handler.
// @Header is a method-level decorator in Nest 10; applying it to the
// class trips TS1238. SCIM clients accept application/json — the
// per-method handlers can set the strict content-type via res if
// some downstream provisioning tool is strict about it.
@ApiTags('scim')
@Public()
@Controller('scim/v2')
export class ScimController {
  constructor(private readonly svc: ScimService) {}

  private async tenant(auth: string | undefined) {
    return this.svc.resolveBearer(auth);
  }

  // ----- Users -----
  @Get('Users')
  async listUsers(
    @Headers('authorization') auth: string,
    @Query('startIndex') startIndex = '1',
    @Query('count') count = '100',
    @Query('filter') filter?: string,
  ) {
    const tid = await this.tenant(auth);
    return this.svc.listUsers(tid, parseInt(startIndex, 10) || 1, parseInt(count, 10) || 100, filter);
  }

  @Get('Users/:id')
  async getUser(@Headers('authorization') auth: string, @Param('id') id: string) {
    const tid = await this.tenant(auth);
    return this.svc.getUser(tid, id);
  }

  @Post('Users')
  @HttpCode(201)
  async createUser(@Headers('authorization') auth: string, @Body() body: any) {
    const tid = await this.tenant(auth);
    return this.svc.createUser(tid, body);
  }

  @Put('Users/:id')
  async replaceUser(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    const tid = await this.tenant(auth);
    return this.svc.replaceUser(tid, id, body);
  }

  @Patch('Users/:id')
  async patchUser(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    const tid = await this.tenant(auth);
    return this.svc.patchUser(tid, id, body);
  }

  @Delete('Users/:id')
  @HttpCode(204)
  async deleteUser(@Headers('authorization') auth: string, @Param('id') id: string) {
    const tid = await this.tenant(auth);
    await this.svc.deleteUser(tid, id);
  }

  // ----- Groups -----
  @Get('Groups')
  async listGroups(
    @Headers('authorization') auth: string,
    @Query('startIndex') startIndex = '1',
    @Query('count') count = '100',
  ) {
    const tid = await this.tenant(auth);
    return this.svc.listGroups(tid, parseInt(startIndex, 10) || 1, parseInt(count, 10) || 100);
  }

  @Get('Groups/:id')
  async getGroup(@Headers('authorization') auth: string, @Param('id') id: string) {
    const tid = await this.tenant(auth);
    return this.svc.getGroup(tid, id);
  }

  @Post('Groups')
  @HttpCode(201)
  async createGroup(@Headers('authorization') auth: string, @Body() body: any) {
    const tid = await this.tenant(auth);
    return this.svc.createGroup(tid, body);
  }

  @Put('Groups/:id')
  async replaceGroup(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    const tid = await this.tenant(auth);
    return this.svc.replaceGroup(tid, id, body);
  }

  @Delete('Groups/:id')
  @HttpCode(204)
  async deleteGroup(@Headers('authorization') auth: string, @Param('id') id: string) {
    const tid = await this.tenant(auth);
    await this.svc.deleteGroup(tid, id);
  }

  // ----- discovery -----
  @Get('ServiceProviderConfig')
  spc() {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        { name: 'OAuth Bearer Token', type: 'oauthbearertoken', primary: true },
      ],
    };
  }
}
