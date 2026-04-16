// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import {CCIPReceiver} from "@chainlink/contracts-ccip/src/v0.8/ccip/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/src/v0.8/ccip/libraries/Client.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract POIRegistry is Ownable2Step, ReentrancyGuard, EIP712, CCIPReceiver {
    using ECDSA for bytes32;

    enum IdentityType { None, Human, Agent }

    struct POIRecord {
        address owner;
        string identifier;
        IdentityType idType;
        bytes32 sigHash;
        uint64 registeredAt;
        uint64 expiresAt;
        uint256 pricePaidWei;
        bytes socialProof;
        bool hasSocialProof;
    }

    mapping(address => POIRecord) public addressToRecord;
    mapping(string => address) public identifierToAddress;
    mapping(address => uint256) public nonces;
    mapping(bytes32 => bool) public reservedNames;
    mapping(address => IdentityType) public addressType;

    AggregatorV3Interface public priceFeed;
    address public feeCollector;

    uint256 public constant RENEWAL_PERIOD = 730 days;
    uint256 public constant GRACE_PERIOD = 90 days;
    bytes32 private constant _REGISTER_TYPEHASH = keccak256("POIRegister(address owner,string username,uint256 nonce)");
    bytes32 private constant _REGISTER_AGENT_TYPEHASH = keccak256("POIRegisterAgent(address owner,string agentId,uint256 nonce)");

    event IdentityRegistered(address indexed owner, string identifier, IdentityType idType, uint256 pricePaid, uint64 expiresAt);
    event AddressUpdated(address indexed oldOwner, address indexed newOwner, string identifier);
    event Renewed(string indexed identifier, uint64 newExpiresAt, uint256 pricePaid);
    event FeesWithdrawn(address indexed token, uint256 amount, address indexed to);

    constructor(
        address _priceFeed,
        address _feeCollector,
        address _ccipRouter
    ) EIP712("POI v3.1", "1") CCIPReceiver(_ccipRouter) Ownable(msg.sender) {
        priceFeed = AggregatorV3Interface(_priceFeed);
        feeCollector = _feeCollector;
    }

    function toLower(string memory str) internal pure returns (string memory) {
        bytes memory bStr = bytes(str);
        bytes memory bLower = new bytes(bStr.length);
        for (uint i = 0; i < bStr.length; i++) {
            if ((uint8(bStr[i]) >= 65) && (uint8(bStr[i]) <= 90)) {
                bLower[i] = bytes1(uint8(bStr[i]) + 32);
            } else {
                bLower[i] = bStr[i];
            }
        }
        return string(bLower);
    }

    function toHexString(uint256 value, uint256 length) internal pure returns (string memory) {
        bytes memory buffer = new bytes(2 * length);
        for (uint256 i = 2 * length; i > 0; i--) {
            buffer[i - 1] = bytes1(uint8(48 + uint256(value & 0xf)));
            if (uint256(value & 0xf) > 9) {
                buffer[i - 1] = bytes1(uint8(87 + uint256(value & 0xf)));
            }
            value >>= 4;
        }
        return string(buffer);
    }

    function getPriceUSD(string calldata username) public pure returns (uint256 usdCents) {
        require(bytes(username)[0] == "@", "Must be @username");
        uint256 len = bytes(username).length - 1;
        require(len >= 3 && len <= 31, "Invalid length");
        if (len >= 7) return 0;
        if (len == 6) return 1000;
        if (len == 5) return 5000;
        if (len == 4) return 25000;
        if (len == 3) return 100000;
        revert("Too short");
    }

    function getPriceWei(string calldata username) public view returns (uint256) {
        uint256 usdCents = getPriceUSD(username);
        if (usdCents == 0) return 0;
        (, int256 bnbPrice,,,) = priceFeed.latestRoundData();
        require(bnbPrice > 0, "Invalid price");
        return (usdCents * 1e20) / uint256(bnbPrice);
    }

    function _verifySig(address owner, string memory identifier, bytes calldata sig, bytes32 typeHash) internal {
        bytes32 structHash = keccak256(abi.encode(typeHash, owner, keccak256(bytes(identifier)), nonces[owner]));
        bytes32 digest = _hashTypedDataV4(structHash);
        require(digest.recover(sig) == owner, "Invalid signature");
        nonces[owner]++;
    }

    function register(string calldata username, bytes calldata sig) external payable nonReentrant {
        require(bytes(username)[0] == "@", "Humans use @");
        string memory lower = toLower(username);
        require(identifierToAddress[lower] == address(0), "Taken");
        require(addressType[msg.sender] == IdentityType.None, "Address already registered");
        require(!reservedNames[keccak256(bytes(lower))], "Reserved");

        _verifySig(msg.sender, lower, sig, _REGISTER_TYPEHASH);

        uint256 price = getPriceWei(lower);
        require(msg.value >= price, "Insufficient payment");

        addressToRecord[msg.sender] = POIRecord({
            owner: msg.sender,
            identifier: lower,
            idType: IdentityType.Human,
            sigHash: keccak256(sig),
            registeredAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + RENEWAL_PERIOD),
            pricePaidWei: price,
            socialProof: "",
            hasSocialProof: false
        });
        identifierToAddress[lower] = msg.sender;
        addressType[msg.sender] = IdentityType.Human;

        if (msg.value > price) {
            payable(msg.sender).transfer(msg.value - price);
        }
        emit IdentityRegistered(msg.sender, lower, IdentityType.Human, price, uint64(block.timestamp + RENEWAL_PERIOD));
    }

    function registerAgent(bytes calldata sig) external nonReentrant {
        require(addressType[msg.sender] == IdentityType.None, "Already registered");
        bytes32 hash = keccak256(abi.encodePacked(msg.sender, block.chainid));
        string memory agentId = string(abi.encodePacked("#agent_", toHexString(uint256(hash), 4)));
        require(identifierToAddress[agentId] == address(0), "Collision");

        _verifySig(msg.sender, agentId, sig, _REGISTER_AGENT_TYPEHASH);

        addressToRecord[msg.sender] = POIRecord({
            owner: msg.sender,
            identifier: agentId,
            idType: IdentityType.Agent,
            sigHash: keccak256(sig),
            registeredAt: uint64(block.timestamp),
            expiresAt: 0,
            pricePaidWei: 0,
            socialProof: "",
            hasSocialProof: false
        });
        identifierToAddress[agentId] = msg.sender;
        addressType[msg.sender] = IdentityType.Agent;
        emit IdentityRegistered(msg.sender, agentId, IdentityType.Agent, 0, 0);
    }

    function renew(string calldata identifier) external payable nonReentrant {
        string memory lower = toLower(identifier);
        POIRecord storage r = addressToRecord[identifierToAddress[lower]];
        require(r.owner == msg.sender, "Not owner");
        require(r.idType == IdentityType.Human, "Agents permanent");
        require(block.timestamp <= r.expiresAt + GRACE_PERIOD, "Grace period over");

        uint256 price = getPriceWei(lower) / 2;
        require(msg.value >= price, "Insufficient payment");

        r.expiresAt = uint64(r.expiresAt + RENEWAL_PERIOD);
        if (msg.value > price) {
            payable(msg.sender).transfer(msg.value - price);
        }
        emit Renewed(lower, r.expiresAt, price);
    }

    function resolveAddress(address user) external view returns (
        string memory identifier,
        IdentityType idType,
        uint64 registeredAt,
        bool expired,
        bool hasSocialProof
    ) {
        POIRecord memory r = addressToRecord[user];
        bool exp = r.idType == IdentityType.Human && r.expiresAt!= 0 && block.timestamp > r.expiresAt;
        return (r.identifier, r.idType, r.registeredAt, exp, r.hasSocialProof);
    }

    function verifyPair(address user, string calldata claimedId) external view returns (
        bool match,
        string memory actualId,
        IdentityType idType,
        bool expired
    ) {
        POIRecord memory r = addressToRecord[user];
        bool exp = r.idType == IdentityType.Human && r.expiresAt!= 0 && block.timestamp > r.expiresAt;
        return (
            keccak256(bytes(toLower(claimedId))) == keccak256(bytes(r.identifier)),
            r.identifier,
            r.idType,
            exp
        );
    }

    function withdraw(address token, uint256 amount) external onlyOwner {
        require(feeCollector!= address(0), "Set feeCollector");
        if (token == address(0)) {
            payable(feeCollector).transfer(amount);
        } else {
            IERC20(token).transfer(feeCollector, amount);
        }
        emit FeesWithdrawn(token, amount, feeCollector);
    }

    function setFeeCollector(address _feeCollector) external onlyOwner {
        feeCollector = _feeCollector;
    }

    function setReserved(bytes32 nameHash, bool reserved) external onlyOwner {
        reservedNames[nameHash] = reserved;
    }

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        // CCIP implementation - validate sender, decode, register
        // Omitted for brevity but included in full repo
    }
}
