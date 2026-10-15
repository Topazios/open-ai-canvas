package app

import (
	"encoding/json"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

type ModelProtocolPolicy string

const (
	ModelProtocolAuto  ModelProtocolPolicy = "auto"
	ModelProtocolFixed ModelProtocolPolicy = "fixed"
)

type ModelProtocolConfig struct {
	Policy    ModelProtocolPolicy `json:"policy"`
	Supported []string            `json:"supported"`
}

func protocolAdapterSupportsAgent(adapter protocol.Adapter) bool {
	if agent, ok := adapter.(protocol.AgentCapability); ok {
		if agent.AgentAvailable() {
			return true
		}
	}
	// These builtins use the host's canonical tool-call implementation.
	switch adapter.Metadata().ID {
	case "chat-completion", "openai-response", "claude-api":
		return true
	default:
		return false
	}
}

func validateModelProtocolConfig(registry *protocol.Registry, capability, primary string, config *ModelProtocolConfig) error {
	if config == nil {
		return nil
	}
	if config.Policy != ModelProtocolAuto && config.Policy != ModelProtocolFixed {
		return BadAuthRequest("协议选择策略必须是 auto 或 fixed")
	}
	if len(config.Supported) > 16 {
		return BadAuthRequest("支持的协议最多 16 项")
	}
	seen := map[string]bool{}
	for _, id := range append([]string{primary}, config.Supported...) {
		adapter, ok := registry.Resolve(id)
		if !ok || !adapter.Metadata().Enabled || adapter.Metadata().UnavailableReason != "" {
			return BadAuthRequest("支持列表包含不可用的协议：" + id)
		}
		if protocolCapabilityFromMetadata(adapter.Metadata()) != capability {
			return BadAuthRequest("支持列表中的协议与模型能力不匹配")
		}
		seen[adapter.Metadata().ID] = true
	}
	// Media adapters carry different sizing, references and polling contracts.
	// Their operation dispatch remains inside the selected adapter.
	if capability != "text" && len(seen) > 1 {
		return BadAuthRequest("媒体模型使用一个适配配置，由该配置分派生成、编辑和轮询接口")
	}
	return nil
}

func selectModelProtocol(registry *protocol.Registry, capability, primary string, config *ModelProtocolConfig, agent bool) (string, error) {
	if err := validateModelProtocolConfig(registry, capability, primary, config); err != nil {
		return "", err
	}
	ids := []string{primary}
	if config != nil && config.Policy == ModelProtocolAuto {
		ids = append(ids, config.Supported...)
	}
	selected, score := "", -1
	for _, id := range ids {
		adapter, ok := registry.Resolve(strings.TrimSpace(id))
		if !ok || !adapter.Metadata().Enabled || adapter.Metadata().UnavailableReason != "" {
			continue
		}
		if capability != "" && protocolCapabilityFromMetadata(adapter.Metadata()) != capability {
			continue
		}
		if agent && !protocolAdapterSupportsAgent(adapter) {
			continue
		}
		rank := 1
		if protocol.ContractForAdapter(adapter.Metadata().ID) == protocol.ContractResponses {
			rank = 2
		}
		if rank > score {
			selected, score = adapter.Metadata().ID, rank
		}
	}
	if selected == "" {
		if !agent {
			return "", BadAuthRequest("模型未配置可用的生成协议")
		}
		return "", BadAuthRequest("模型未配置可用的 Agent 工具调用协议")
	}
	return selected, nil
}

// Selection is made before persistence and charging. Workers keep the pinned
// adapter instead of silently changing endpoints when settings change.
func (s *Service) pinTaskModelProtocol(input map[string]any) error {
	config, _ := input["config"].(map[string]any)
	if config == nil {
		return nil
	}
	delete(config, "selectedProtocol")
	primary := stringValue(config["interfaceType"])
	if isWorkflowProviderInterface(primary) {
		return nil
	}
	capability := stringValue(input["mode"])
	var policy *ModelProtocolConfig
	channelID := firstNonEmpty(stringValue(config["channelId"]), systemChannelIDFromBaseURL(stringValue(config["baseUrl"])))
	if channelID != "" {
		item, err := s.repo.ChannelModelByKey(channelID, firstNonEmpty(stringValue(config["channelModelKey"]), stringValue(config["model"])))
		if err != nil {
			return err
		}
		profile, err := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
		if err != nil {
			return err
		}
		if profile != nil {
			policy = profile.Protocols
		}
		primary, capability = string(item.Protocol), item.Capability
	} else {
		var typed providerConfig
		data, err := json.Marshal(config)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(data, &typed); err != nil {
			return err
		}
		if typed.CapabilityConfig != nil {
			policy = typed.CapabilityConfig.Protocols
		}
	}
	if primary == "" {
		return nil
	}
	selected, err := selectModelProtocol(s.protocolRegistry(), capability, primary, policy, input["agentRequests"] != nil)
	if err != nil {
		return err
	}
	config["interfaceType"], config["selectedProtocol"] = selected, selected
	config["apiFormat"] = channelAPIFormatForProtocol(stringValue(config["apiFormat"]), model.ChannelInterfaceType(selected))
	return nil
}

func validatePinnedProtocol(registry *protocol.Registry, selected, capability string) error {
	adapter, ok := registry.Resolve(selected)
	if !ok || !adapter.Metadata().Enabled || adapter.Metadata().UnavailableReason != "" || protocolCapabilityFromMetadata(adapter.Metadata()) != capability {
		return fmt.Errorf("任务已选定的协议 %s 不可用，请恢复该协议后重试", selected)
	}
	return nil
}

// A relay already carries a wire-specific body. Authorize its requested
// endpoint against stored declarations; never rewrite that body or guess support.
func (s *Service) ResolveSystemProxyProtocol(item *model.ChannelModel, path string) (model.ChannelInterfaceType, error) {
	if item.Capability != "text" {
		return item.Protocol, nil
	}
	requested := map[string]string{"/responses": "openai-response", "/chat/completions": "chat-completion", "/messages": "claude-api"}[path]
	if requested == "" {
		return item.Protocol, nil
	}
	if protocol.ContractForAdapter(requested) == protocol.ContractForAdapter(string(item.Protocol)) {
		if err := validatePinnedProtocol(s.protocolRegistry(), string(item.Protocol), "text"); err != nil {
			return "", err
		}
		return item.Protocol, nil
	}
	profile, err := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
	if err != nil {
		return "", err
	}
	if profile != nil && profile.Protocols != nil && profile.Protocols.Policy == ModelProtocolAuto {
		for _, id := range profile.Protocols.Supported {
			if id == requested {
				if err := validatePinnedProtocol(s.protocolRegistry(), id, "text"); err != nil {
					return "", err
				}
				return model.ChannelInterfaceType(id), nil
			}
		}
	}
	return "", BadAuthRequest("当前模型未授权该文本接口，请刷新配置或确认渠道支持声明")
}
