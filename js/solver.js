const BN = require('bn.js')

_27 = 27;

'use strict';
const nameValToStr = (name, coef, first) => {
    const ONE = new BN(1)
    const ZERO = new BN(0)
    const coefBN = new BN(coef)
    if (coefBN.eq(ZERO)) {
        return ''
    }
    let str = ''
    if (first && coefBN.eq(ONE)) {
        return name
    }
    if (coefBN.eq(ONE)) {
        str += '+'
    } else if (coefBN.eq(ONE.neg())) {
        str += '-'
    } else {
        str += (coefBN.gt(ZERO) ? '+' : '') + coefBN.toString()
    }
    str += ` ${name}`
    return str
}

const linearExpression = (coefs) => {
    const varNames = ['tinInvest', 'dropInvest', 'tinRedeem', 'dropRedeem']
    let str = ''
    let first = true
    const n = varNames.length
    for (let i = 0; i < n; i += 1) {
        str += `${nameValToStr(varNames[i], coefs[i], first)} `
        first = false
    }
    return str
}

const calculateOptimalSolution = (state, orders, weights) => {
    return require('clp-wasm/clp-wasm.all').then((clp) => {
        const e27 = new BN(1).mul(new BN(10).pow(new BN(_27)))
        const maxTinRatio = e27.sub(state.minDropRatio)
        const minTinRatio = e27.sub(state.maxDropRatio)

        const minTINRatioLb = state.maxDropRatio
            .neg()
            .mul(state.netAssetValue)
            .sub(state.maxDropRatio.mul(state.reserve))
            .add(state.seniorAsset.mul(e27))

        const maxTINRatioLb = state.minDropRatio
            .mul(state.netAssetValue)
            .add(state.minDropRatio.mul(state.reserve))
            .sub(state.seniorAsset.mul(e27))

        const varWeights = [
            parseFloat(weights.tinInvest.toString()),
            parseFloat(weights.dropInvest.toString()),
            parseFloat(weights.tinRedeem.toString()),
            parseFloat(weights.dropRedeem.toString()),
        ]
        const minTINRatioLbCoeffs = [state.maxDropRatio, minTinRatio.neg(), state.maxDropRatio.neg(), minTinRatio]
        const maxTINRatioLbCoeffs = [state.minDropRatio.neg(), maxTinRatio, state.minDropRatio, maxTinRatio.neg()]

        const createProblem = (varWeights, orderMins, orderMaxs) => {
            const lp = `Maximize
  obj: ${linearExpression(varWeights)}
Subject To
  reserve: ${linearExpression([1, 1, -1, -1])} >= ${state.reserve.neg()}
  maxReserve: ${linearExpression([1, 1, -1, -1])} <= ${state.maxReserve.sub(state.reserve)}
  minTINRatioLb: ${linearExpression(minTINRatioLbCoeffs)} >= ${minTINRatioLb}
  maxTINRatioLb: ${linearExpression(maxTINRatioLbCoeffs)} >= ${maxTINRatioLb}
Bounds
  ${orderMins[0]} <= tinInvest  <= ${orderMaxs[0]}
  ${orderMins[1]} <= dropInvest <= ${orderMaxs[1]}
  ${orderMins[2]} <= tinRedeem  <= ${orderMaxs[2]}
  ${orderMins[3]} <= dropRedeem <= ${orderMaxs[3]}
End`
            return lp;
        };

        let isFeasible = false;
        let solutionVector = null;
        const linear = weights.mode != "Priority";
        const priorityWeight = weights.priorityWeight || new BN('10000000000');
        if (linear) {
            const orderMaxs = [orders.tinInvest, orders.dropInvest, orders.tinRedeem, orders.dropRedeem];
            const lp = createProblem(varWeights, [0, 0, 0, 0], orderMaxs);
            $('#lpProblem').val(lp);
            const output = clp.solve(lp, 0)
            $('#solution').val(JSON.stringify(output, null, 4));
            solutionVector = output.solution.map((x) => new BN(clp.bnRound(x)));
            isFeasible |= output.infeasibilityRay.length == 0 && output.integerSolution;
        } else {
            const orderMins = [0, 0, 0, 0];
            const orderMaxs = [orders.tinInvest, orders.dropInvest, orders.tinRedeem, orders.dropRedeem];
            const priorityIndices = [0, 1, 2, 3];
            priorityIndices.sort((a, b) => varWeights[a] > varWeights[b] ? -1 : varWeights[a] < varWeights[b] ? 1 : 0);

            for (const pI of priorityIndices) {
                const weights = [1, 1, 1, 1];
                weights[pI] = priorityWeight;
                const lp = createProblem(weights, orderMins, orderMaxs);
                $('#lpProblem').val(lp);
                const output = clp.solve(lp, 0);
                $('#solution').val(JSON.stringify(output, null, 4));
                isFeasible |= output.infeasibilityRay.length == 0 && output.integerSolution;
                if (!isFeasible)
                    break;
                const oP = new BN(clp.bnRound(output.solution[pI]));
                orderMins[pI] = oP;
                orderMaxs[pI] = oP;
            }
            solutionVector = orderMaxs;
        }

        const linearEval = (coefs, vars) => {
            let res = new BN(0)
            if (vars.length != 4 || coefs.length != 4) throw new Error('Invalid sequences here')
            for (let i = 0; i < 4; i++) {
                res = res.add(new BN(vars[i]).mul(new BN(coefs[i])))
            }
            return res
        }
        //         const debugConstraints = `
        // reserve: ${linearEval([1, 1, -1, -1], solutionVector)} >= ${state.reserve.neg()}
        // maxReserve: ${linearEval([1, 1, -1, -1], solutionVector)} <= ${state.maxReserve.sub(state.reserve)}
        // minTINRatioLb: ${linearEval(minTINRatioLbCoeffs, solutionVector)} >= ${minTINRatioLb}
        // maxTINRatioLb: ${linearEval(maxTINRatioLbCoeffs, solutionVector)} >= ${maxTINRatioLb}`
        //         console.log(debugConstraints)

        if (!isFeasible) {
            // If it's not possible to go into a healthy state, calculate the best possible solution to break the constraints less
            const currentSeniorRatio = state.seniorAsset.mul(e27).div(state.netAssetValue.add(state.reserve))

            if (currentSeniorRatio.lte(state.minDropRatio)) {
                const dropInvest = orders.dropInvest
                const tinRedeem = BN.min(orders.tinRedeem, state.reserve.add(dropInvest))

                return {
                    isFeasible: isFeasible,
                    dropInvest,
                    tinRedeem,
                    tinInvest: new BN(0),
                    dropRedeem: new BN(0),
                }
            } else if (currentSeniorRatio.gte(state.maxDropRatio)) {
                const tinInvest = orders.tinInvest
                const dropRedeem = BN.min(orders.dropRedeem, state.reserve.add(tinInvest))

                return {
                    isFeasible: isFeasible,
                    tinInvest,
                    dropRedeem,
                    dropInvest: new BN(0),
                    tinRedeem: new BN(0),
                }
            } else if (state.reserve.gte(state.maxReserve)) {
                const dropRedeem = BN.min(orders.dropRedeem, state.reserve) // Limited either by the order or the reserve
                const tinRedeem = BN.min(orders.tinRedeem, state.reserve.sub(dropRedeem)) // Limited either by the order or what's remaining of the reserve after the DROP redemptions

                return {
                    isFeasible: isFeasible,
                    tinRedeem,
                    dropRedeem,
                    dropInvest: new BN(0),
                    tinInvest: new BN(0),
                }
            } else {
                return {
                    isFeasible: false,
                    dropInvest: new BN(0),
                    dropRedeem: new BN(0),
                    tinInvest: new BN(0),
                    tinRedeem: new BN(0),
                }
            }
        }

        return {
            isFeasible,
            dropInvest: solutionVector[1],
            dropRedeem: solutionVector[3],
            tinInvest: solutionVector[0],
            tinRedeem: solutionVector[2],
        }
    })
};


const ordersList = ["tinInvest", "dropInvest", "tinRedeem", "dropRedeem"];

async function loadTestCase(testCaseUrl) {
    testCaseUrl = testCaseUrl || 'tinlake.test.json';
    let req = await fetch(testCaseUrl);
    let testCase = await req.json();
    setUpUi(testCase);
}

function rms(str) {
    return str.replace(/\s+/g, '')
}

function getFloatParameter(name) {
    return parseFloat(rms($(`#${name}`).val()));
}

function getBNParameter(name) {
    const value = rms($(`#${name}Value`).val());
    const base = $(`#${name}Exp`).val();
    if (base == '0') {
        return value;
    }
    const number = {
        value: value,
        base: base,
    };
    const add = parseFloat($(`#${name}Add`).val());
    if (add !== 0) number["add"] = add;
    return number;
}

function objToNum(jsonNumber) {
    if (typeof jsonNumber === "string") {
        return new BN(jsonNumber);
    }
    const add = jsonNumber.add ? jsonNumber.add : 0;
    return new BN(jsonNumber.value * 100000)
        .mul(new BN(10).pow(new BN(jsonNumber.base - 5)))
        .add(new BN(add));
}

function paramsToBn(obj) {
    const resBN = {};
    for (let prop in obj) {
        if (obj.hasOwnProperty(prop)) {
            resBN[prop] = objToNum(obj[prop]);
        }
    }
    return resBN;
}

function getWeight(name) {
    return rms($(`#${name}`).val());
}

function prepareProblem() {
    return {
        weights: {
            tinInvest: getWeight("tinInvestWeight"),
            dropInvest: getWeight("dropInvestWeight"),
            tinRedeem: getWeight("tinRedeemWeight"),
            dropRedeem: getWeight("dropRedeemWeight"),
            mode: $('#weightMode').val(),
            priorityWeight: rms($('#priorityWeight').val())
        },
        state: {
            seniorAsset: getBNParameter("seniorAsset"),
            netAssetValue: getBNParameter("netAssetValue"),
            reserve: getBNParameter("reserve"),
            maxReserve: getBNParameter("maxReserve"),
            minTinRatio: {
                value: getFloatParameter("minTinRatioValue"),
                base: _27,
            },
            maxTinRatio: {
                value: getFloatParameter("maxTinRatioValue"),
                base: _27,
            },
        },
        orders: {
            tinInvest: getBNParameter("tinInvest"),
            dropInvest: getBNParameter("dropInvest"),
            tinRedeem: getBNParameter("tinRedeem"),
            dropRedeem: getBNParameter("dropRedeem"),
        },
    };
}

function buildProblem() {
    const testCase = prepareProblem();
    solveProblem(testCase);
}

function exportTestCase() {
    const json = prepareProblem();
    const content = JSON.stringify(json, null, 4);
    var a = document.createElement("a");
    var file = new Blob([content], { type: "application/json" });
    a.href = URL.createObjectURL(file);
    a.download = "testCase.json";
    a.click();
}

function importTestCase() {
    const fileInput = document.createElement("input");
    readFile = function (e) {
        var file = e.target.files[0];
        if (!file) {
            return;
        }
        var reader = new FileReader();
        reader.onload = function (e) {
            const contents = e.target.result;
            const testCase = JSON.parse(contents);
            setUpUi(testCase);
            document.body.removeChild(fileInput);
        };
        reader.readAsText(file);
    };

    fileInput.type = "file";
    fileInput.style.display = "none";
    fileInput.onchange = readFile;
    document.body.appendChild(fileInput);
    fileInput.click();
}

async function solveProblem(testCase) {
    testCase.state.maxDropRatio = {
        value: 1 - testCase.state.minTinRatio.value,
        base: testCase.state.minTinRatio.base,
    };
    testCase.state.minDropRatio = {
        value: 1 - testCase.state.maxTinRatio.value,
        base: testCase.state.maxTinRatio.base,
    };
    const state = paramsToBn(testCase.state);
    const orders = paramsToBn(testCase.orders);
    const res = await calculateOptimalSolution(state, orders, testCase.weights);

    const seniorAssetEp1 = state.seniorAsset.add(res.dropInvest).sub(res.dropRedeem);
    const reserveEp1 = state.reserve.add(res.tinInvest).add(res.dropInvest).sub(res.tinRedeem).sub(res.dropRedeem);
    const scale = 10000000;
    const dropRatioEp1Scaled = seniorAssetEp1.mul(new BN(scale)).div(state.netAssetValue.add(reserveEp1));
    const dropRatioEp1 = parseFloat(dropRatioEp1Scaled) / scale;
    const tinRatioEp1 = 1 - dropRatioEp1;

    const friendlyNum = (bn) => {
        const str = bn.toString();
        return `${str}   (${str.length} digits)`;
    };
    $('#newTinRatio').text(tinRatioEp1.toFixed(5));
    $('#newReserve').text(friendlyNum(reserveEp1));
    $('#newSeniorAsset').text(friendlyNum(seniorAssetEp1));
    const isFeasible = res.isFeasible;
    $("#ordersRow").css(
        "background-color",
        !isFeasible ? "tomato" : "honeydew"
    );

    for (let order of ordersList) {
        const base = testCase.orders[order].base;
        const f = res[order];
        const exp = new BN(10).pow(new BN(base));
        const v = f.gt(exp) ? f.div(exp) : 0;
        $(`#${order}SliderOut`).slider("values", 0, v.toString());

        const fulfilled = f.eq(orders[order]);
        $(`#${order}FulfillStatus`).text((fulfilled ? "ALL" : "PARTIAL"))
            .css('color', fulfilled ? 'green' : 'red')
            .css('font-weight', 'bold');
        $(`#${order}Fulfilled`).text(f.toString());
    }
}

function setUpUi(testCase) {
    const orders = testCase.orders;
    const weights = testCase.weights || {
        tinInvest: 10000,
        dropInvest: 1000,
        tinRedeem: 100000,
        dropRedeem: 1000000,
    };
    const state = testCase.state;
    // Setup weights
    for (const order of ordersList) {
        const selW = `#${order}Weight`;
        $(selW).attr({ value: weights[order].toString() }).change(() => {
            buildProblem();
        });
    }

    function getRatio(ratio) {
        if (typeof ratio === "string") {
            const rbn = new BN(ratio);
            const scaleDigits = 5;
            const scale = new BN(1).mul(new BN(10).pow(new BN(_27 - scaleDigits)))
            const ratio0_1 = rbn.div(scale).toNumber() / Math.pow(10, scaleDigits);
            return ratio0_1;
        }
        else if ('value' in ratio) {
            return ratio.value;
        }
        alert("Can't process ratio value");
    }

    const minTinRatio = getRatio(state.minTinRatio);
    const maxTinRatio = getRatio(state.maxTinRatio);
    $("#tinRatioSlider").slider({
        range: true,
        min: 0,
        max: 1,
        step: 0.01,
        values: [minTinRatio, maxTinRatio],
        slide: function (event, ui) {
            for (var i = 0; i < ui.values.length; ++i) {
                $("input.sliderValue[data-index=" + i + "]").val(ui.values[i]);
            }
            buildProblem();
        },
    });
    $(minTinRatioValue).val(minTinRatio);
    $(maxTinRatioValue).val(maxTinRatio);
    $("input.sliderValue").change(function () {
        var $this = $(this);
        $("#tinRatioSlider").slider(
            "values",
            $this.data("index"),
            $this.val()
        );
        buildProblem();
    });

    function setBigNumberParameter(name, parm) {

        const sliderSel = `#${name}Slider`;
        const inputSel = `#${name}Value`;
        const expSel = `#${name}Exp`;
        const addSel = `#${name}Add`;
        if (typeof parm === "string") {
            $(sliderSel).css('display', 'none');
            $(inputSel).attr({ 'type': "text", 'value': parm }).css('width', '230px');
            $(expSel).attr({ value: 0 });
            $(addSel).attr({ value: 0 });
        }
        else {
            $(sliderSel).css('display', 'inline-block').slider({
                min: 0,
                max: parm.max || parm.value * 2 || 100,
                step: 1,
                values: [parm.value],
                slide: function (_, ui) {
                    for (var i = 0; i < ui.values.length; ++i) {
                        $(inputSel).val(ui.values[i]);
                    }
                    buildProblem();
                },
            });
            $(inputSel)
                .attr({ min: 0, value: parm.value })
                .change(function () {
                    var $this = $(this);
                    $(sliderSel).slider("values", 0, $this.val());
                    buildProblem();
                });

            $(expSel)
                .attr({ value: parm.base })
                .change(() => buildProblem());
            $(addSel)
                .attr({ value: parm.add || 0 })
                .change(() => buildProblem());
        }
    }

    const parmList = [
        "seniorAsset",
        "netAssetValue",
        "reserve",
        "maxReserve",
    ];
    for (let parmName of parmList) {
        setBigNumberParameter(parmName, state[parmName]);
    }

    for (const parmName of ordersList) {
        const parm = orders[parmName];
        setBigNumberParameter(parmName, orders[parmName]);
        const sliderSel = `#${parmName}SliderOut`;
        $(sliderSel)
            .slider({
                min: 0,
                disabled: true,
                max: parm.max || parm.value * 2 || 100,
                step: 1,
                values: [parm.value],
            })
            .addClass("out-slider");
    }
}

$(async () => {
    $("#testCase").selectmenu({
        change: async (_, data) => {
            await loadTestCase(data.item.value);
            setTimeout(buildProblem(), 100);
        }
    });
    $("#weightMode").selectmenu({
        change: (_, data) => {
            setTimeout(buildProblem(), 100);
        }
    });
    $('#priorityWeight').attr({ value: '10 000 000 000' }).change(() => buildProblem());

    await loadTestCase($("#testCase").val());
    setTimeout(buildProblem(), 100);
    $('#import-btn').click(() => importTestCase());
    $('#export-btn').click(() => exportTestCase());
});

$("body").on("keyup", (e) => {
    var ch = String.fromCharCode(e.keyCode);
    if (ch === "V" && e.ctrlKey && e.altKey) {
        navigator.clipboard.readText()
            .then(text => {
                try {
                    let testCase = JSON.parse(text);
                    setUpUi(testCase);
                    buildProblem()
                } catch (e) {
                    alert('Could not load test case from clipboard: ' + e.toString())
                }
            })
            .catch(err => {
                console.error('Failed to read clipboard contents: ', err);
            });
        return;
    }
    if (ch === "C" && e.ctrlKey && e.altKey) {
        const json = prepareProblem();
        const el = document.createElement('textarea');
        el.value = JSON.stringify(json, null, 4);
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
    }
});

