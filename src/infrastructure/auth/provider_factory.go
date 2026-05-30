package auth

import (
	"encoding/json"
	"fmt"

	"fsd-mrbs/src/domain/auth"
)

// ProviderFactory creates identity provider instances based on tenant configuration
type ProviderFactory struct {
	providers map[string]auth.IdentityProvider // cache of tenant -> provider
}

// NewProviderFactory creates a new provider factory
func NewProviderFactory() *ProviderFactory {
	return &ProviderFactory{
		providers: make(map[string]auth.IdentityProvider),
	}
}

// GetProvider returns the appropriate identity provider for a tenant
// The provider is selected based on tenant.IdentityProviderConfig
func (f *ProviderFactory) GetProvider(tenantID string, config map[string]interface{}) (auth.IdentityProvider, error) {
	// Check cache first
	if provider, ok := f.providers[tenantID]; ok {
		return provider, nil
	}

	// Extract provider type from config
	providerType, err := getProviderType(config)
	if err != nil {
		return nil, err
	}

	// Create provider based on type
	var provider auth.IdentityProvider
	switch providerType {
	case auth.ProviderTypeLDAP:
		provider, err = f.createLDAPProvider(config)
	case auth.ProviderTypeSAML:
		provider, err = f.createSAMLProvider(config)
	case auth.ProviderTypeOAuth2:
		provider, err = f.createOAuth2Provider(config)
	default:
		return nil, fmt.Errorf("unsupported identity provider type: %s", providerType)
	}

	if err != nil {
		return nil, fmt.Errorf("failed to create %s provider: %w", providerType, err)
	}

	// Cache the provider
	f.providers[tenantID] = provider

	return provider, nil
}

// getProviderType extracts the provider type from configuration
func getProviderType(config map[string]interface{}) (auth.ProviderType, error) {
	if config == nil {
		return "", fmt.Errorf("identity provider config is nil")
	}

	typeVal, ok := config["type"]
	if !ok {
		return "", fmt.Errorf("provider type not specified in config")
	}

	providerType := auth.ProviderType(fmt.Sprintf("%v", typeVal))
	switch providerType {
	case auth.ProviderTypeLDAP, auth.ProviderTypeSAML, auth.ProviderTypeOAuth2:
		return providerType, nil
	default:
		return "", fmt.Errorf("invalid provider type: %s", providerType)
	}
}

// createLDAPProvider creates an LDAP provider from configuration
func (f *ProviderFactory) createLDAPProvider(config map[string]interface{}) (*LDAPProvider, error) {
	ldapConfig := LDAPConfig{}

	// Extract server URL
	if serverURL, ok := config["server_url"].(string); ok {
		ldapConfig.ServerURL = serverURL
	}

	// Extract bind DN
	if bindDN, ok := config["bind_dn"].(string); ok {
		ldapConfig.BindDN = bindDN
	}

	// Extract bind password
	if bindPwd, ok := config["bind_password"].(string); ok {
		ldapConfig.BindPwd = bindPwd
	}

	// Extract base DN
	if baseDN, ok := config["base_dn"].(string); ok {
		ldapConfig.BaseDN = baseDN
	}

	// Extract timeout (default to 30 seconds)
	ldapConfig.Timeout = 30
	if timeout, ok := config["timeout"].(float64); ok {
		ldapConfig.Timeout = int(timeout)
	}

	return NewLDAPProvider(ldapConfig), nil
}

// createSAMLProvider creates a SAML provider from configuration
func (f *ProviderFactory) createSAMLProvider(config map[string]interface{}) (*SAMLProvider, error) {
	samlConfig := SAMLConfig{
		AttributeMapping: make(map[string]string),
	}

	// Extract entity ID
	if entityID, ok := config["entity_id"].(string); ok {
		samlConfig.EntityID = entityID
	}

	// Extract SSO URL
	if ssoURL, ok := config["sso_url"].(string); ok {
		samlConfig.SSOURL = ssoURL
	}

	// Extract SLO URL
	if sloURL, ok := config["slo_url"].(string); ok {
		samlConfig.SLOURL = sloURL
	}

	// Extract certificate
	if cert, ok := config["certificate"].(string); ok {
		samlConfig.Certificate = cert
	}

	// Extract private key
	if pk, ok := config["private_key"].(string); ok {
		samlConfig.PrivateKey = pk
	}

	// Extract IDP metadata URL
	if idpMetadataURL, ok := config["idp_metadata_url"].(string); ok {
		samlConfig.IDPMetadataURL = idpMetadataURL
	}

	// Extract attribute mapping
	if attrMap, ok := config["attribute_mapping"].(map[string]interface{}); ok {
		for k, v := range attrMap {
			if strVal, ok := v.(string); ok {
				samlConfig.AttributeMapping[k] = strVal
			}
		}
	}

	return NewSAMLProvider(samlConfig), nil
}

// createOAuth2Provider creates an OAuth2 provider from configuration
func (f *ProviderFactory) createOAuth2Provider(config map[string]interface{}) (*OAuth2Provider, error) {
	oauth2Config := OAuth2Config{}

	// Extract client ID
	if clientID, ok := config["client_id"].(string); ok {
		oauth2Config.ClientID = clientID
	}

	// Extract client secret
	if clientSecret, ok := config["client_secret"].(string); ok {
		oauth2Config.ClientSecret = clientSecret
	}

	// OIDC issuer is required for id_token validation; without it the
	// provider has no way to verify the iss claim.
	if issuer, ok := config["issuer"].(string); ok {
		oauth2Config.Issuer = issuer
	}

	// JWKS endpoint for signing-key lookup.
	if jwks, ok := config["jwks_url"].(string); ok {
		oauth2Config.JWKSURL = jwks
	}

	// Extract auth URL
	if authURL, ok := config["auth_url"].(string); ok {
		oauth2Config.AuthURL = authURL
	}

	// Extract token URL
	if tokenURL, ok := config["token_url"].(string); ok {
		oauth2Config.TokenURL = tokenURL
	}

	// Extract userinfo URL
	if userInfoURL, ok := config["userinfo_url"].(string); ok {
		oauth2Config.UserInfoURL = userInfoURL
	}

	// Extract redirect URL
	if redirectURL, ok := config["redirect_url"].(string); ok {
		oauth2Config.RedirectURL = redirectURL
	}

	// Extract scopes
	if scopes, ok := config["scopes"].([]interface{}); ok {
		for _, s := range scopes {
			if strVal, ok := s.(string); ok {
				oauth2Config.Scopes = append(oauth2Config.Scopes, strVal)
			}
		}
	}

	// Extract provider name
	if providerName, ok := config["provider_name"].(string); ok {
		oauth2Config.ProviderName = providerName
	}

	return NewOAuth2Provider(oauth2Config), nil
}

// ClearCache clears the provider cache
func (f *ProviderFactory) ClearCache() {
	f.providers = make(map[string]auth.IdentityProvider)
}

// ClearTenantProvider removes a specific tenant's provider from cache
func (f *ProviderFactory) ClearTenantProvider(tenantID string) {
	delete(f.providers, tenantID)
}

// MarshalConfig is a helper function to marshal provider config to JSON
func MarshalConfig(config map[string]interface{}) ([]byte, error) {
	return json.Marshal(config)
}

// UnmarshalConfig is a helper function to unmarshal provider config from JSON
func UnmarshalConfig(data []byte) (map[string]interface{}, error) {
	var config map[string]interface{}
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}
	return config, nil
}
